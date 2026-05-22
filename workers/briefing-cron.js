/**
 * Cloudflare Workers — 브리핑 자동화
 * 환경변수: ANTHROPIC_API_KEY, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT
 * 선택 환경변수: RESEND_API_KEY, NEWSLETTER_FROM, NEWSLETTER_RECIPIENTS, NEWSLETTER_ENABLED
 *
 * 배포 명령어:
 *   cd workers && wrangler deploy
 *
 * 시크릿 등록:
 *   wrangler secret put ANTHROPIC_API_KEY
 *   wrangler secret put GOOGLE_SERVICE_ACCOUNT
 *   wrangler secret put BRIEFING_RUN_TOKEN
 *
 * Google Sheets 헤더 행(Row 1) 수동 작성:
 *   날짜 | 카테고리 | 제목 | 요약 | 출처명 | 링크 | 이미지URL | 상태
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

    if (url.pathname === '/api/briefing/newsletter-preview' && request.method === 'GET') {
      try {
        const rows = await readFromSheets(env);
        const items = pickNewsletterItems(rows);
        return new Response(renderNewsletterHtml(items, { preview: true }), {
          headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' },
        });
      } catch (e) {
        return new Response(renderNewsletterHtml(sampleNewsletterItems(), { preview: true, error: e.message }), {
          headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    }

    if (url.pathname === '/api/briefing/run' && request.method === 'POST') {
      try {
        requireEnv(env, ['BRIEFING_RUN_TOKEN']);
        const token = request.headers.get('x-briefing-token') || url.searchParams.get('token');
        if (token !== env.BRIEFING_RUN_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        const items = await runBriefing(env);
        return new Response(JSON.stringify({ ok: true, count: items.length, items }), {
          headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    if (url.pathname === '/api/briefing/import' && request.method === 'POST') {
      try {
        requireEnv(env, ['BRIEFING_RUN_TOKEN', 'GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT']);
        const token = request.headers.get('x-briefing-token') || url.searchParams.get('token');
        if (token !== env.BRIEFING_RUN_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        const body = await request.json();
        const items = await enrichBriefingImages(normalizeBriefingItems(body.items || body));
        await appendToSheets(env, items);
        return new Response(JSON.stringify({ ok: true, count: items.length, items }), {
          headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    if (url.pathname === '/api/briefing/newsletter-test' && request.method === 'POST') {
      try {
        requireEnv(env, ['BRIEFING_RUN_TOKEN']);
        const token = request.headers.get('x-briefing-token') || url.searchParams.get('token');
        if (token !== env.BRIEFING_RUN_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        const rows = await readFromSheets(env);
        const items = pickNewsletterItems(rows);
        const result = await sendNewsletter(env, items, { test: true });
        return new Response(JSON.stringify({ ok: true, ...result }), {
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
  if (env.NEWSLETTER_ENABLED === 'true') {
    try {
      const result = await sendNewsletter(env, items);
      console.log(`뉴스레터 발송 완료: ${result.count}명`);
    } catch (err) {
      console.error('[newsletter]', err.message);
    }
  }
  console.log(`브리핑 ${items.length}건 Sheets 저장 완료`);
  return items;
}

function normalizeBriefingItems(items) {
  if (!Array.isArray(items)) throw new Error('items 배열이 필요합니다');
  return items.map((item) => ({
    date: String(item.date || getKSTDateStr()),
    category: String(item.category || ''),
    title: String(item.title || ''),
    summary: String(item.summary || ''),
    source: String(item.source || ''),
    link: String(item.link || ''),
    image: String(item.image || ''),
  })).filter((item) => item.category && item.title && item.link);
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
            `오늘 날짜(${today}) 기준 최근 7일 이내에 공개/보도된 최신 정보 중 중요도 높은 5~8개를 골라줘.\n` +
            `관심 영역: 대학·공공기관 온라인 콘텐츠 제작, 원격교육/이러닝, 스튜디오·XR·실감형 콘텐츠 구축, LMS/교육 플랫폼/SW 개발, 에듀테크 보안·개인정보, AI 트렌드, AI 모델.\n` +
            `우리는 대학·기관 대상으로 온라인 교육 콘텐츠 제작, 스튜디오 구축, SW 개발을 하는 회사다. 관심 영역은 검색 범위와 분류 기준일 뿐이며, 영역별로 반드시 1개씩 맞추지 마. 최신성, 신뢰도, 발주/제안/사업기회와의 관련성을 우선해.\n` +
            `출처는 한국어 뉴스, 공공기관 공지, 정부 보도자료, 국내 공식 블로그를 우선해. 해외 AI 모델/트렌드도 가능하면 한국어 해설 기사나 한국어 공식 페이지를 사용해.\n` +
            `date는 브리핑 발행일인 ${today}로 통일해. 단, 원문 공개일/보도일이 최근 7일을 벗어난 항목은 제외해.\n` +
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
    item.status || 'published',
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
  const rows = (data.values ?? []).map(([date, category, title, summary, source, link, image, status]) => ({
    date: date ?? '',
    category: category ?? '',
    title: title ?? '',
    summary: summary ?? '',
    source: source ?? '',
    link: link ?? '',
    image: image || fallbackImage(category),
    status: normalizeBriefingStatus(status),
  })).filter((item) => !isPlaceholderBriefing(item) && isPublishedBriefing(item));

  const seen = new Set();
  const deduped = rows.reverse().filter((item) => {
    const key = [
      String(item.date || '').trim(),
      String(item.category || '').trim(),
      String(item.title || '').trim(),
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).reverse();

  const byDate = new Map();
  for (const item of deduped) {
    const date = String(item.date || '').trim();
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(item);
  }

  return Array.from(byDate.values()).flatMap((items) => items.slice(-8));
}

function isPlaceholderBriefing(item) {
  const category = String(item.category || '').trim();
  const title = String(item.title || '').trim();
  const summary = String(item.summary || '').trim();
  const link = String(item.link || '').trim();
  return (
    title === '테스트 제목' ||
    summary === '테스트 요약' ||
    link === 'https://example.com' ||
    link === 'http://example.com' ||
    title.includes('??') ||
    summary.includes('??') ||
    category.includes('??') ||
    title.includes('�') ||
    summary.includes('�') ||
    category.includes('�')
  );
}

function normalizeBriefingStatus(status) {
  return String(status || 'published').trim().toLowerCase();
}

function isPublishedBriefing(item) {
  const status = normalizeBriefingStatus(item.status);
  return !['hidden', 'hide', 'draft', 'private', 'hold', '보류', '숨김', '비공개', '삭제'].includes(status);
}

// ─── 뉴스레터 미리보기/발송 ────────────────────────────────────────────────

function pickNewsletterItems(items) {
  const rows = Array.isArray(items) ? items : [];
  const today = getKSTDateStr();
  const sorted = rows
    .filter((item) => item && item.title && item.link)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const latestDate = sorted.find((item) => item.date)?.date || today;
  const latest = sorted.filter((item) => item.date === latestDate);
  return (latest.length ? latest : sorted).slice(0, 6);
}

function sampleNewsletterItems() {
  const today = getKSTDateStr();
  return [
    {
      date: today,
      category: 'AI · AX',
      title: '대학 온라인 교육 현장에 생성형 AI 활용 확대',
      summary: '대학과 공공기관에서 콘텐츠 제작, 학습관리, 행정 효율화를 위한 AI 도입 논의가 활발해지고 있습니다. 교육 콘텐츠 제작사에는 AI 기반 제작 프로세스와 운영 자동화 제안 기회가 커지고 있습니다.',
      source: 'XEMIRO Briefing',
      link: 'https://xemi.co.kr/',
      image: fallbackImage('AI'),
    },
    {
      date: today,
      category: '콘텐츠 제작',
      title: '실감형 스튜디오와 온라인 콘텐츠 고도화 수요 증가',
      summary: '대학·기관의 스튜디오 구축, XR 콘텐츠, 영상 기반 교육 자산 관리 수요가 이어지고 있습니다. 구축 이후 운영 체계와 콘텐츠 제작 워크플로우까지 함께 제안하는 접근이 중요합니다.',
      source: 'XEMIRO Briefing',
      link: 'https://xemi.co.kr/',
      image: fallbackImage('스튜디오'),
    },
    {
      date: today,
      category: '정책 · 공공',
      title: '교육 플랫폼과 개인정보보호 기준 점검 필요',
      summary: 'LMS, 교육 플랫폼, 학습 데이터 활용이 늘면서 개인정보보호와 보안 기준이 제안 평가의 핵심 요소로 부상하고 있습니다. 개발·운영 제안서에 보안 체계를 명확히 반영할 필요가 있습니다.',
      source: 'XEMIRO Briefing',
      link: 'https://xemi.co.kr/',
      image: fallbackImage('보안'),
    },
  ];
}

function renderNewsletterHtml(items, options = {}) {
  const picked = pickNewsletterItems(items);
  const today = getKSTDateStr();
  const subject = `${today} XEMIRO Briefing`;
  const previewNotice = options.error
    ? `<div style="margin:0 auto 16px;max-width:760px;padding:12px 16px;border-radius:12px;background:#fff3cd;color:#5f4300;font-size:13px;">시트 데이터를 불러오지 못해 샘플로 표시합니다: ${escapeHtml(options.error)}</div>`
    : '';
  const cards = picked.map((item) => renderNewsletterCard(item)).join('');

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;background:#f7f1ea;font-family:Arial,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;color:#2d2926;">
  <div style="padding:28px 16px 40px;">
    ${previewNotice}
    <main style="max-width:760px;margin:0 auto;background:#fff;border:1px solid #eaded2;border-radius:24px;overflow:hidden;box-shadow:0 18px 50px rgba(55,35,28,0.12);">
      <section style="padding:34px 34px 30px;background:linear-gradient(135deg,#2f2723 0%,#94442e 56%,#f4a024 130%);color:#fff;">
        <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.76;">XEMIRO Briefing</div>
        <h1 style="margin:12px 0 10px;font-size:32px;line-height:1.25;letter-spacing:-.02em;">오늘의 교육·AI 인사이트</h1>
        <p style="margin:0;font-size:15px;line-height:1.7;color:rgba(255,255,255,.82);">대학·기관 콘텐츠 제작, 스튜디오 구축, SW 개발 관점에서 볼 만한 소식을 골랐습니다.</p>
        <div style="margin-top:22px;display:inline-block;padding:8px 13px;border-radius:999px;background:rgba(255,255,255,.16);font-size:13px;">${escapeHtml(today)}</div>
      </section>
      <section style="padding:26px 24px 8px;">
        ${cards || renderEmptyNewsletter()}
      </section>
      <section style="padding:8px 34px 30px;">
        <a href="${escapeHtml(envAwareBriefingUrl())}" style="display:block;text-align:center;text-decoration:none;border-radius:14px;background:#94442e;color:#fff;padding:15px 18px;font-weight:700;font-size:14px;">브리핑 전체 보기</a>
      </section>
      <footer style="padding:22px 34px;background:#fbf8f3;border-top:1px solid #eaded2;color:#77645d;font-size:12px;line-height:1.7;">
        이 메일은 XEMIRO 자동 브리핑 시스템에서 생성되었습니다.<br>
        수신자와 발송 시간은 Worker 환경변수로 관리됩니다.
      </footer>
    </main>
  </div>
</body>
</html>`;
}

function renderNewsletterCard(item) {
  const image = item.image || fallbackImage(item.category);
  return `<article style="display:block;margin:0 0 18px;border:1px solid #eaded2;border-radius:18px;overflow:hidden;background:#fff;">
    ${image ? `<a href="${escapeHtml(item.link)}" target="_blank" style="display:block;height:210px;background:#f5efe8;overflow:hidden;"><img src="${escapeHtml(image)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;"></a>` : ''}
    <div style="padding:20px 22px 22px;">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
        <span style="display:inline-block;padding:5px 9px;border-radius:999px;background:#f5e9e2;color:#94442e;font-size:12px;font-weight:700;">${escapeHtml(item.category)}</span>
        <span style="font-size:12px;color:#8a7770;">${escapeHtml(item.source || '')}</span>
      </div>
      <h2 style="margin:0 0 9px;font-size:22px;line-height:1.35;letter-spacing:-.02em;color:#2d2926;">${escapeHtml(item.title)}</h2>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.75;color:#55433e;">${escapeHtml(item.summary || '')}</p>
      <a href="${escapeHtml(item.link)}" target="_blank" style="display:inline-block;color:#94442e;text-decoration:none;font-size:14px;font-weight:700;">원문 보기 →</a>
    </div>
  </article>`;
}

function renderEmptyNewsletter() {
  return '<div style="padding:28px;border:1px dashed #d8c8ba;border-radius:16px;color:#77645d;text-align:center;">아직 발송할 브리핑이 없습니다.</div>';
}

async function sendNewsletter(env, items, options = {}) {
  requireEnv(env, ['RESEND_API_KEY']);
  const recipients = parseRecipients(env.NEWSLETTER_RECIPIENTS || env.NEWSLETTER_TEST_RECIPIENTS);
  if (!recipients.length) throw new Error('NEWSLETTER_RECIPIENTS 환경변수가 필요합니다');

  const picked = pickNewsletterItems(items);
  const today = getKSTDateStr();
  const subject = options.test ? `[TEST] ${today} XEMIRO Briefing` : `${today} XEMIRO Briefing`;
  const from = env.NEWSLETTER_FROM || 'XEMIRO Briefing <onboarding@resend.dev>';
  const html = renderNewsletterHtml(picked);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: recipients,
      subject,
      html,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`뉴스레터 발송 실패: ${JSON.stringify(data)}`);
  return { count: recipients.length, id: data.id || null };
}

function parseRecipients(value) {
  return String(value || '')
    .split(/[,\n;]/)
    .map((email) => email.trim())
    .filter(Boolean);
}

function envAwareBriefingUrl() {
  return 'https://xemiro.pages.dev/briefing.html';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
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
  return `${sheetName}!A${startRow}:H`;
}

function getKSTDateStr() {
  // Workers 런타임은 UTC — KST(+9) 오프셋 적용
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}
