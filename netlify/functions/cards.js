import { createSign } from 'crypto';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Content-Type': 'application/json',
};

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DEFAULT_SHEET_NAMES = ['시트1', 'Sheet1'];

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

function unique(values) {
  const seen = {};
  return values.filter((value) => {
    if (!value || seen[value]) return false;
    seen[value] = true;
    return true;
  });
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function findHeaderIndex(headers, names) {
  const normalizedNames = names.map(normalizeHeader);
  return headers.findIndex((header) => normalizedNames.includes(normalizeHeader(header)));
}

function looksLikeHeader(row) {
  const normalized = row.map(normalizeHeader);
  return ['type', 'url', 'title', '제목', '링크'].some((name) => normalized.includes(normalizeHeader(name)));
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function normalizeType(value) {
  const type = normalizeHeader(value);
  if (['book', '도서'].includes(type)) return 'book';
  if (['seminar', '세미나', 'event', '행사'].includes(type)) return 'seminar';
  return 'youtube';
}

function cellByHeader(row, index, fallbackIndex) {
  if (index !== -1 && row[index] !== undefined) return row[index];
  return row[fallbackIndex] || '';
}

function rowToCard(row, rowNumber, headerMap) {
  let card;
  if (headerMap) {
    card = {
      rowNumber,
      type: normalizeType(cellByHeader(row, headerMap.type, 0)),
      url: cellByHeader(row, headerMap.url, 1),
      title: cellByHeader(row, headerMap.title, 2),
      desc: cellByHeader(row, headerMap.desc, 3),
      image: cellByHeader(row, headerMap.image, 4),
    };
  } else {
    card = {
      rowNumber,
      type: normalizeType(row[0] || ''),
      url: row[1] || '',
      title: row[2] || '',
      desc: row[3] || '',
      image: row[4] || '',
    };

    if (!card.title && row[0] && looksLikeUrl(row[1])) {
      card = {
        rowNumber,
        type: normalizeType(row[3] || ''),
        url: row[1] || '',
        title: row[0] || '',
        desc: row[2] || '',
        image: row[4] || '',
      };
    }
  }

  card.url = String(card.url || '').trim();
  card.title = String(card.title || '').trim();
  card.desc = String(card.desc || '').trim();
  card.image = String(card.image || '').trim();
  return card;
}

function valuesToCards(values) {
  if (!Array.isArray(values) || !values.length) return [];

  const firstRow = values[0] || [];
  const hasHeader = looksLikeHeader(firstRow);
  let headerMap = null;
  let startIndex = 0;

  if (hasHeader) {
    headerMap = {
      type: findHeaderIndex(firstRow, ['type', '유형', '분류', '카테고리']),
      url: findHeaderIndex(firstRow, ['url', 'link', '링크', '주소']),
      title: findHeaderIndex(firstRow, ['title', '제목']),
      desc: findHeaderIndex(firstRow, ['desc', 'description', '요약', '설명', '내용']),
      image: findHeaderIndex(firstRow, ['image', 'thumbnail', '썸네일', '이미지']),
    };
    if (headerMap.title === -1) return [];
    startIndex = 1;
  }

  return values.slice(startIndex)
    .map((row, index) => rowToCard(row || [], startIndex + index + 1, headerMap))
    .filter((card) => card.title && !['title', '제목'].includes(normalizeHeader(card.title)));
}

async function getSheetNames(sheetId, auth) {
  const res = await fetch(`${SHEETS}/${sheetId}?fields=sheets.properties.title`, { headers: auth });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets metadata ${res.status}: ${JSON.stringify(data)}`);
  return (data.sheets || []).map((sheet) => sheet.properties.title);
}

async function readCardsFromSheet(sheetId, auth, sheetName) {
  const res = await fetch(`${SHEETS}/${sheetId}/values/${encodeURIComponent(sheetName + '!A1:Z')}`, {
    headers: auth,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets GET ${sheetName} ${res.status}: ${JSON.stringify(data)}`);
  return valuesToCards(data.values || []);
}

async function readCards(sheetId, auth) {
  const preferred = process.env.GOOGLE_SHEET_NAME || '';
  const sheetNames = await getSheetNames(sheetId, auth);
  const candidates = unique([preferred, ...DEFAULT_SHEET_NAMES, ...sheetNames]);
  let lastError = null;
  let bestCards = [];

  for (const sheetName of candidates) {
    try {
      const cards = await readCardsFromSheet(sheetId, auth, sheetName);
      if (cards.length > bestCards.length) bestCards = cards;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError && !sheetNames.length) throw lastError;
  return bestCards;
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
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'GOOGLE_SERVICE_ACCOUNT 파싱 실패: ' + e.message }) };
  }

  try {
    const token = await getAccessToken(creds);
    const auth  = { Authorization: `Bearer ${token}` };

    if (event.httpMethod === 'GET') {
      const cards = await readCards(sheetId, auth);
      return { statusCode: 200, headers: CORS, body: JSON.stringify(cards) };
    }

    if (event.httpMethod === 'POST') {
      const { type, url, title, desc, image } = JSON.parse(event.body || '{}');
      if (!title) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '제목 필수' }) };
      }
      if (!url) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'URL 필수' }) };
      }

      const sheetName = process.env.GOOGLE_SHEET_NAME || '시트1';
      const range = encodeURIComponent(sheetName + '!A:E');
      const res = await fetch(
        `${SHEETS}/${sheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [[type, url || '', title, desc || '', image || '']] }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(`Sheets POST ${res.status}: ${JSON.stringify(data)}`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    if (event.httpMethod === 'PUT') {
      const { rowNumber, type, url, title, desc, image } = JSON.parse(event.body || '{}');
      const targetRow = Number(rowNumber);
      if (!Number.isInteger(targetRow) || targetRow < 1) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '수정할 행 번호가 올바르지 않습니다' }) };
      }
      if (!title) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '제목 필수' }) };
      }
      if (!url) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'URL 필수' }) };
      }

      const sheetName = process.env.GOOGLE_SHEET_NAME || '시트1';
      const range = encodeURIComponent(`${sheetName}!A${targetRow}:E${targetRow}`);
      const res = await fetch(`${SHEETS}/${sheetId}/values/${range}?valueInputOption=RAW`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[type, url || '', title, desc || '', image || '']] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`Sheets PUT ${res.status}: ${JSON.stringify(data)}`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    if (event.httpMethod === 'DELETE') {
      const params = new URLSearchParams(event.rawQuery || '');
      const body = event.body ? JSON.parse(event.body) : {};
      const rowNumber = Number(event.queryStringParameters?.row || params.get('row') || body.rowNumber);
      if (!Number.isInteger(rowNumber) || rowNumber < 1) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '삭제할 행 번호가 올바르지 않습니다' }) };
      }

      const tabId = Number(process.env.GOOGLE_SHEET_TAB_ID || 0);
      const res = await fetch(`${SHEETS}/${sheetId}:batchUpdate`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            deleteDimension: {
              range: {
                sheetId: tabId,
                dimension: 'ROWS',
                startIndex: rowNumber - 1,
                endIndex: rowNumber,
              },
            },
          }],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`Sheets DELETE ${res.status}: ${JSON.stringify(data)}`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  } catch (err) {
    console.error('[cards]', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
