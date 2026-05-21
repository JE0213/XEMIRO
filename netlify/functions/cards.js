const { google } = require('googleapis');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const RANGE_READ  = 'Sheet1!A2:D';
const RANGE_WRITE = 'Sheet1!A:D';

function getSheets() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;

  try {
    const sheets = getSheets();

    // ── GET: 카드 목록 반환 ──
    if (event.httpMethod === 'GET') {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: RANGE_READ,
      });
      const rows = res.data.values || [];
      const cards = rows
        .filter(r => r[2])           // title 없는 빈 행 제외
        .map(r => ({
          type:  r[0] || 'youtube',
          url:   r[1] || '',
          title: r[2] || '',
          desc:  r[3] || '',
        }));
      return { statusCode: 200, headers: CORS, body: JSON.stringify(cards) };
    }

    // ── POST: 카드 추가 ──
    if (event.httpMethod === 'POST') {
      const { type, url, title, desc } = JSON.parse(event.body || '{}');
      if (!title) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '제목 필수' }) };
      }
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: RANGE_WRITE,
        valueInputOption: 'RAW',
        requestBody: { values: [[type, url, title, desc]] },
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
