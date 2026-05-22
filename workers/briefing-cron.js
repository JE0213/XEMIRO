/**
 * Cloudflare Workers — 브리핑 자동화
 * 환경변수: ANTHROPIC_API_KEY, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT
 *
 * 배포 명령어:
 *   cd workers && wrangler deploy
 *
 * 시크릿 등록:
 *   wrangler secret put ANTHROPIC_API_KEY
 *   wrangler secret put GOOGLE_SERVICE_ACCOUNT
 *
 * Google Sheets 헤더 행(Row 1) 수동 작성:
 *   날짜 | 카테고리 | 제목 | 요약 | 출처명 | 링크 | 이미지URL
 */

export default {
  // 매일 UTC 00:00 (KST 09:00) 자동 실행
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runBriefing(env).catch((err) => {
        console.error('[briefing-cron]', err.message);
        throw err;
      })
    );
  },

  // HTML 페이지에서 GET /api/briefing 으로 데이터 요청
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === '/api/briefing' && request.method === 'GET') {
      try {
        const rows = await readFromSheets(env);
        return new Response(JSON.stringify(rows), {
          headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};

// ─── 브리핑 실행 ───────────────────────────────────────────────────────────

async function runBriefing(env) {
  requireEnv(env, ['ANTHROPIC_API_KEY', 'GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT']);
  const items = await enrichBriefingImages(await fetchBriefingFromClaude(env.ANTHROPIC_API_KEY));
  await appendToSheets(env, items);
  console.log(`브리핑 ${items.length}건 Sheets 저장 완료`);
}

// ─── Claude API (web_search 아젠틱 루프) ───────────────────────────────────

async function fetchBriefingFromClaude(apiKey) {
  const today = getKSTDateStr();

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      messages: [
        {
          role: 'user',
          content:
            `오늘 날짜(${today}) 기준 최근 1~2주 이내 아래 카테고리별 최신 정보 각 1개씩 총 6개.\n` +
            `카테고리: 이러닝, 대학 교육정책, 대학 재정지원사업, AI 트렌드, AI 모델, 에듀테크\n` +
            `관점: 대학·기관 대상 이러닝 콘텐츠/SW개발/스튜디오 구축 회사\n` +
            `출처: 뉴스, 공공기관 공지, 정부 보도자료 등 신뢰 가능한 출처\n` +
            `각 항목은 실제 원문 URL을 포함하고, 제목은 과장 없이 간결하게 작성.\n` +
            `JSON 형식으로만 반환 (다른 텍스트 없이 배열만):\n` +
            `[{"date":"YYYY-MM-DD","category":"카테고리명","title":"제목","summary":"2-3문장 요약","source":"출처명","link":"URL","image":"이미지 URL 또는 빈 문자열"}]`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err}`);
  }

  const data = await res.json();
  if (data.stop_reason !== 'end_turn') {
    throw new Error(`Claude API 응답 미완료: stop_reason=${data.stop_reason}`);
  }

  const text = data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('응답에서 JSON 배열을 찾을 수 없음');

  const items = JSON.parse(match[0]);
  if (!Array.isArray(items)) throw new Error('Claude 응답이 JSON 배열이 아님');
  return items;
}

// ─── 기사 대표 이미지 자동 추출 ─────────────────────────────────────────────

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function absoluteUrl(image, pageUrl) {
  if (!image) return '';
  try {
    return new URL(decodeEntities(image), pageUrl).href;
  } catch (_) {
    return decodeEntities(image);
  }
}

function pickMetaImage(html, pageUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["'][^>]*>/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return absoluteUrl(match[1], pageUrl);
  }
  return '';
}

function fallbackImage(category) {
  const images = {
    'AI 트렌드': 'https://images.unsplash.com/photo-1485827404703-89b55fcc595e?w=1200&q=80',
    'AI 모델': 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=1200&q=80',
    '이러닝': 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=1200&q=80',
    '대학 교육정책': 'https://images.unsplash.com/photo-1523050854058-8df90110c9f1?w=1200&q=80',
    '대학 재정지원사업': 'https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=1200&q=80',
    '에듀테크': 'https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=1200&q=80',
  };
  return images[category] || 'https://images.unsplash.com/photo-1497366754035-f200968a6e72?w=1200&q=80';
}

async function fetchArticleImage(link) {
  if (!link) return '';
  try {
    const pageUrl = new URL(link);
    if (!/^https?:$/.test(pageUrl.protocol)) return '';
    const res = await fetch(pageUrl.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 XEMI Briefing Bot',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) return '';
    const html = await res.text();
    return pickMetaImage(html.slice(0, 200000), pageUrl.href);
  } catch (_) {
    return '';
  }
}

async function enrichBriefingImages(items) {
  return Promise.all(items.map(async (item) => {
    const image = item.image || (await fetchArticleImage(item.link));
    return { ...item, image: image || fallbackImage(item.category) };
  }));
}

// ─── Google Sheets JWT 인증 ────────────────────────────────────────────────

function pemToDer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function strToB64url(str) {
  const bytes = new TextEncoder().encode(str);
  return bufToB64url(bytes.buffer);
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = strToB64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = strToB64url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  );

  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(serviceAccount.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${bufToB64url(sig)}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Google OAuth 실패: ${err}`);
  }

  const { access_token } = await tokenRes.json();
  return access_token;
}

// ─── Google Sheets 쓰기 ────────────────────────────────────────────────────

async function appendToSheets(env, items) {
  requireEnv(env, ['GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT']);
  const sa = readServiceAccount(env);
  const token = await getAccessToken(sa);
  const range = encodeURIComponent(getBriefingRange(env));

  const values = items.map((item) => [
    item.date ?? '',
    item.category ?? '',
    item.title ?? '',
    item.summary ?? '',
    item.source ?? '',
    item.link ?? '',
    item.image ?? fallbackImage(item.category),
  ]);

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets 쓰기 실패: ${err}`);
  }
}

// ─── Google Sheets 읽기 ────────────────────────────────────────────────────

async function readFromSheets(env) {
  requireEnv(env, ['GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT']);
  const sa = readServiceAccount(env);
  const token = await getAccessToken(sa);
  const range = encodeURIComponent(getBriefingRange(env, 2));

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets 읽기 실패: ${err}`);
  }

  const data = await res.json();
  return (data.values ?? []).map(([date, category, title, summary, source, link, image]) => ({
    date: date ?? '',
    category: category ?? '',
    title: title ?? '',
    summary: summary ?? '',
    source: source ?? '',
    link: link ?? '',
    image: image || fallbackImage(category),
  }));
}

// ─── 유틸 ─────────────────────────────────────────────────────────────────

function requireEnv(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`환경변수 누락: ${missing.join(', ')}`);
  }
}

function readServiceAccount(env) {
  try {
    const serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
    if (!serviceAccount.client_email || !serviceAccount.private_key) {
      throw new Error('client_email/private_key 필드 누락');
    }
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    return serviceAccount;
  } catch (err) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT 파싱 실패: ${err.message}`);
  }
}

function getBriefingRange(env, startRow = '') {
  const sheetName = env.GOOGLE_SHEET_NAME || '시트1';
  return `${sheetName}!A${startRow}:G`;
}

function getKSTDateStr() {
  // Workers 런타임은 UTC — KST(+9) 오프셋 적용
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}
