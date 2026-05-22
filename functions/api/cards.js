const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Content-Type': 'application/json',
};

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DEFAULT_GOOGLE_SHEET_ID = '1s3NBMsKi9g0zLCiYBKvDcep35C7xvNMG-8R9r9crC2M';
const DEFAULT_SHEET_NAMES = ['시트1', 'Sheet1'];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

function base64Url(input) {
  var bytes = input instanceof Uint8Array ? input : new TextEncoder().encode(input);
  var binary = '';
  bytes.forEach(function(byte) {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  var base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  var binary = atob(base64);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function getAccessToken(creds) {
  var now = Math.floor(Date.now() / 1000);
  var header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var payload = base64Url(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));

  var key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(creds.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  var signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(header + '.' + payload)
  );
  var jwt = header + '.' + payload + '.' + base64Url(new Uint8Array(signature));

  var res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  var json = await res.json();
  if (!json.access_token) throw new Error('Token error: ' + JSON.stringify(json));
  return json.access_token;
}

function readServiceAccount(env) {
  try {
    var raw = env.GOOGLE_SERVICE_ACCOUNT || '{}';
    var creds = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!creds.client_email || !creds.private_key) throw new Error('필드 누락');
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    return creds;
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT 파싱 실패: ' + e.message);
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (_) {
    return {};
  }
}

function unique(values) {
  var seen = {};
  return values.filter(function(value) {
    if (!value || seen[value]) return false;
    seen[value] = true;
    return true;
  });
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function findHeaderIndex(headers, names) {
  var normalizedNames = names.map(normalizeHeader);
  for (var i = 0; i < headers.length; i += 1) {
    if (normalizedNames.indexOf(normalizeHeader(headers[i])) !== -1) return i;
  }
  return -1;
}

function looksLikeHeader(row) {
  var normalized = row.map(normalizeHeader);
  return ['type', 'url', 'title', '제목', '링크'].some(function(name) {
    return normalized.indexOf(normalizeHeader(name)) !== -1;
  });
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function normalizeType(value) {
  var type = normalizeHeader(value);
  if (['book', '도서'].indexOf(type) !== -1) return 'book';
  if (['seminar', '세미나', 'event', '행사'].indexOf(type) !== -1) return 'seminar';
  return 'youtube';
}

function rowToCard(row, rowNumber, headerMap) {
  var card;
  if (headerMap) {
    card = {
      rowNumber: rowNumber,
      type: normalizeType(row[headerMap.type] || ''),
      url: row[headerMap.url] || '',
      title: row[headerMap.title] || '',
      desc: row[headerMap.desc] || '',
      image: row[headerMap.image] || '',
    };
  } else {
    card = {
      rowNumber: rowNumber,
      type: normalizeType(row[0] || ''),
      url: row[1] || '',
      title: row[2] || '',
      desc: row[3] || '',
      image: row[4] || '',
    };

    if (!card.title && row[0] && looksLikeUrl(row[1])) {
      card = {
        rowNumber: rowNumber,
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

  var firstRow = values[0] || [];
  var hasHeader = looksLikeHeader(firstRow);
  var headerMap = null;
  var startIndex = 0;

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
    .map(function(row, index) {
      return rowToCard(row || [], startIndex + index + 1, headerMap);
    })
    .filter(function(card) {
      return card.title && normalizeHeader(card.title) !== 'title' && normalizeHeader(card.title) !== '제목';
    });
}

async function getSheetNames(sheetId, auth) {
  var res = await fetch(SHEETS + '/' + sheetId + '?fields=sheets.properties.title', {
    headers: auth,
  });
  var data = await res.json();
  if (!res.ok) throw new Error('Sheets metadata ' + res.status + ': ' + JSON.stringify(data));
  return (data.sheets || []).map(function(sheet) { return sheet.properties.title; });
}

async function readCardsFromSheet(sheetId, auth, sheetName) {
  var res = await fetch(SHEETS + '/' + sheetId + '/values/' + encodeURIComponent(sheetName + '!A1:Z'), {
    headers: auth,
  });
  var data = await res.json();
  if (!res.ok) throw new Error('Sheets GET ' + sheetName + ' ' + res.status + ': ' + JSON.stringify(data));
  return valuesToCards(data.values || []);
}

async function readCards(sheetId, auth, env) {
  var preferred = env.GOOGLE_SHEET_NAME || '';
  var sheetNames = await getSheetNames(sheetId, auth);
  var candidates = unique([preferred].concat(DEFAULT_SHEET_NAMES).concat(sheetNames));
  var lastError = null;
  var bestCards = [];

  for (var i = 0; i < candidates.length; i += 1) {
    try {
      var cards = await readCardsFromSheet(sheetId, auth, candidates[i]);
      if (cards.length > bestCards.length) bestCards = cards;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError && !sheetNames.length) throw lastError;
  return bestCards;
}

export async function onRequest(context) {
  var request = context.request;
  var env = context.env || {};

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: CORS });
  }

  var sheetId = env.GOOGLE_SHEET_ID || DEFAULT_GOOGLE_SHEET_ID;
  if (!sheetId) {
    return jsonResponse({ error: 'GOOGLE_SHEET_ID 환경변수 없음' }, 500);
  }

  try {
    var creds = readServiceAccount(env);
    var token = await getAccessToken(creds);
    var auth = { Authorization: 'Bearer ' + token };

    if (request.method === 'GET') {
      var cards = await readCards(sheetId, auth, env);
      return jsonResponse(cards);
    }

    if (request.method === 'POST') {
      var body = await readJson(request);
      if (!body.title) {
        return jsonResponse({ error: '제목 필수' }, 400);
      }
      if (!body.url) {
        return jsonResponse({ error: 'URL 필수' }, 400);
      }

      var sheetName = env.GOOGLE_SHEET_NAME || '시트1';
      var postRes = await fetch(
        SHEETS + '/' + sheetId + '/values/' + encodeURIComponent(sheetName + '!A:E') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
        {
          method: 'POST',
          headers: Object.assign({}, auth, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ values: [[body.type, body.url || '', body.title, body.desc || '', body.image || '']] }),
        }
      );
      var postData = await postRes.json();
      if (!postRes.ok) throw new Error('Sheets POST ' + postRes.status + ': ' + JSON.stringify(postData));
      return jsonResponse({ ok: true });
    }

    if (request.method === 'DELETE') {
      var url = new URL(request.url);
      var deleteBody = await readJson(request);
      var rowNumber = Number(url.searchParams.get('row') || deleteBody.rowNumber);
      if (!Number.isInteger(rowNumber) || rowNumber < 1) {
        return jsonResponse({ error: '삭제할 행 번호가 올바르지 않습니다' }, 400);
      }

      var tabId = Number(env.GOOGLE_SHEET_TAB_ID || 0);
      var deleteRes = await fetch(SHEETS + '/' + sheetId + ':batchUpdate', {
        method: 'POST',
        headers: Object.assign({}, auth, { 'Content-Type': 'application/json' }),
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
      var deleteData = await deleteRes.json();
      if (!deleteRes.ok) throw new Error('Sheets DELETE ' + deleteRes.status + ': ' + JSON.stringify(deleteData));
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  } catch (err) {
    console.error('[cards]', err.message);
    return jsonResponse({ error: err.message }, 500);
  }
}
