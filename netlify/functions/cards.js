import { createSign } from 'crypto';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

async function getAccessToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss:   creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  })).toString('base64url');

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const sig = signer.sign(creds.private_key, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;

  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('Token error: ' + JSON.stringify(json));
  return json.access_token;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'GOOGLE_SHEET_ID 환경변수 없음' }) };
  }

  let creds;
  try {
    creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
    if (!creds.client_email || !creds.private_key) throw new Error('필드 누락');
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'GOOGLE_SERVICE_ACCOUNT 파싱 실패: ' + e.message }) };
  }

  try {
    const token = await getAccessToken(creds);
    const auth  = { Authorization: `Bearer ${token}` };

    // ── GET: 카드 목록 반환 ──
    if (event.httpMethod === 'GET') {
      const res  = await fetch(`${SHEETS}/${sheetId}/values/Sheet1!A2:D`, { headers: auth });
      const data = await res.json();
      if (!res.ok) throw new Error(`Sheets GET ${res.status}: ${JSON.stringify(data)}`);

      const cards = (data.values || [])
        .filter(r => r[2])
        .map(r => ({ type: r[0] || 'youtube', url: r[1] || '', title: r[2] || '', desc: r[3] || '' }));
      return { statusCode: 200, headers: CORS, body: JSON.stringify(cards) };
    }

    // ── POST: 카드 추가 ──
    if (event.httpMethod === 'POST') {
      const { type, url, title, desc } = JSON.parse(event.body || '{}');
      if (!title) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '제목 필수' }) };
      }

      const range = encodeURIComponent('Sheet1!A:D');
      const res = await fetch(
        `${SHEETS}/${sheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [[type, url || '', title, desc || '']] }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(`Sheets POST ${res.status}: ${JSON.stringify(data)}`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  } catch (err) {
    console.error('[cards]', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
