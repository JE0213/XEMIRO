const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Content-Type': 'application/json',
};

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

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

export async function onRequest(context) {
  var request = context.request;
  var env = context.env || {};

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: CORS });
  }

  var sheetId = env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    return jsonResponse({ error: 'GOOGLE_SHEET_ID 환경변수 없음' }, 500);
  }

  try {
    var creds = readServiceAccount(env);
    var token = await getAccessToken(creds);
    var auth = { Authorization: 'Bearer ' + token };

    if (request.method === 'GET') {
      var getRes = await fetch(SHEETS + '/' + sheetId + '/values/' + encodeURIComponent('시트1!A1:E'), {
        headers: auth,
      });
      var getData = await getRes.json();
      if (!getRes.ok) throw new Error('Sheets GET ' + getRes.status + ': ' + JSON.stringify(getData));

      var cards = (getData.values || [])
        .map(function(r, i) {
          return {
            rowNumber: i + 1,
            type: r[0] || 'youtube',
            url: r[1] || '',
            title: r[2] || '',
            desc: r[3] || '',
            image: r[4] || '',
          };
        })
        .filter(function(card) {
          return card.title && card.title.toLowerCase() !== 'title';
        });
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

      var postRes = await fetch(
        SHEETS + '/' + sheetId + '/values/' + encodeURIComponent('시트1!A:E') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
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
