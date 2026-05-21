const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

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

export async function onRequest(context) {
  const request = context.request;
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: CORS });
  }
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  }

  const target = new URL(request.url).searchParams.get('url');
  if (!target) return jsonResponse({ error: 'url 필수' }, 400);

  let pageUrl;
  try {
    pageUrl = new URL(target);
    if (!/^https?:$/.test(pageUrl.protocol)) throw new Error('invalid protocol');
  } catch (_) {
    return jsonResponse({ error: 'URL 형식이 올바르지 않습니다' }, 400);
  }

  try {
    const res = await fetch(pageUrl.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 XEMI Curation Preview',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
    });
    const html = await res.text();
    const image = pickMetaImage(html.slice(0, 200000), pageUrl.href);
    return jsonResponse({ image });
  } catch (err) {
    return jsonResponse({ error: err.message, image: '' }, 502);
  }
}
