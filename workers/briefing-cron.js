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
 *   날짜 | 카테고리 | 제목 | 요약 | 출처명 | 링크
 */

export default {
  // 매일 UTC 00:00 (KST 09:00) 자동 실행
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBriefing(env));
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
  const items = await fetchBriefingFromClaude(env.ANTHROPIC_API_KEY);
  await appendToSheets(env, items);
  console.log(`브리핑 ${items.length}건 Sheets 저장 완료`);
}

// ─── Claude API (web_search 아젠틱 루프) ───────────────────────────────────

async function fetchBriefingFromClaude(apiKey) {
  const today = getKSTDateStr();

  const messages = [
    {
      role: 'user',
      content:
        `오늘 날짜(${today}) 기준 최근 1~2주 이내 아래 카테고리별 최신 정보 각 1개씩 총 6개.\n` +
        `카테고리: 이러닝, 대학 교육정책, 대학 재정지원사업, AI 트렌드, AI 모델, 에듀테크\n` +
        `관점: 대학·기관 대상 이러닝 콘텐츠/SW개발/스튜디오 구축 회사\n` +
        `출처: 뉴스, 공공기관 공지, 정부 보도자료 등 신뢰 가능한 출처\n` +
        `JSON 형식으로만 반환 (다른 텍스트 없이 배열만):\n` +
        `[{"date":"YYYY-MM-DD","category":"카테고리명","title":"제목","summary":"2-3문장 요약","source":"출처명","link":"URL"}]`,
    },
  ];

  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Claude API ${res.status}: ${err}`);
    }

    const data = await res.json();

    if (data.stop_reason === 'end_turn') {
      const text = data.content.find((c) => c.type === 'text')?.text ?? '';
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('응답에서 JSON 배열을 찾을 수 없음');
      return JSON.parse(match[0]);
    }

    if (data.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: data.content });
      const results = data.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: '' }));
      messages.push({ role: 'user', content: results });
      continue;
    }

    throw new Error(`예기치 못한 stop_reason: ${data.stop_reason}`);
  }

  throw new Error('최대 재시도 횟수 초과');
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
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
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
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const token = await getAccessToken(sa);
  const range = encodeURIComponent('Sheet1!A:F');

  const values = items.map((item) => [
    item.date ?? '',
    item.category ?? '',
    item.title ?? '',
    item.summary ?? '',
    item.source ?? '',
    item.link ?? '',
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
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const range = encodeURIComponent('시트1!A2:F');

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets 읽기 실패: ${err}`);
  }

  const data = await res.json();
  return (data.values ?? []).map(([date, category, title, summary, source, link]) => ({
    date: date ?? '',
    category: category ?? '',
    title: title ?? '',
    summary: summary ?? '',
    source: source ?? '',
    link: link ?? '',
  }));
}

// ─── 유틸 ─────────────────────────────────────────────────────────────────

function getKSTDateStr() {
  // Workers 런타임은 UTC — KST(+9) 오프셋 적용
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}
