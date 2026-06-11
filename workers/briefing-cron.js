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
        const curationItems = await readCurationCards(env).catch(() => []);
        return new Response(renderNewsletterHtml(rows, { preview: true, curationItems }), {
          headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' },
        });
      } catch (e) {
        return new Response(renderNewsletterHtml(sampleNewsletterItems(), { preview: true, error: e.message, curationItems: sampleCurationItems() }), {
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

    if (url.pathname === '/api/briefing/debug-feeds' && request.method === 'GET') {
      try {
        requireEnv(env, ['BRIEFING_RUN_TOKEN']);
        const token = request.headers.get('x-briefing-token') || url.searchParams.get('token');
        if (token !== env.BRIEFING_RUN_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        const debug = await debugKoreanNewsCandidates();
        return new Response(JSON.stringify(debug), {
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
        const curationItems = await readCurationCards(env).catch(() => []);
        const result = await sendNewsletter(env, rows, { test: true, curationItems });
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

const MIN_BRIEFING_ITEMS = 5;
const MAX_BRIEFING_ITEMS = 8;

async function runBriefing(env) {
  requireEnv(env, ['ANTHROPIC_API_KEY', 'GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT']);
  const today = getKSTDateStr();
  const generated = normalizeBriefingItems(await fetchBriefingFromClaude(env));
  let items = generated;

  if (items.length < MIN_BRIEFING_ITEMS) {
    console.warn(`[briefing-cron] Claude returned only ${items.length} items. Backfilling from news feeds.`);
    const fallback = normalizeBriefingItems(await fetchBriefingFromFeeds(env, today));
    items = mergeBriefingItems([...items, ...fallback]).slice(0, MAX_BRIEFING_ITEMS);
  }

  items = await enrichBriefingImages(items);
  if (items.length < MIN_BRIEFING_ITEMS) {
    console.warn(`[briefing-cron] Enriched briefing has only ${items.length} items. Adding deterministic feed summaries.`);
    const candidates = await fetchKoreanNewsCandidates();
    const deterministic = normalizeBriefingItems(buildBriefingFromCandidates(candidates, today));
    items = mergeBriefingItems([...items, ...deterministic]).slice(0, MAX_BRIEFING_ITEMS);
  }

  const savedCount = await appendToSheets(env, items);
  if (env.NEWSLETTER_ENABLED === 'true') {
    try {
      const curationItems = await readCurationCards(env).catch(() => []);
      const result = await sendNewsletter(env, items, { curationItems });
      console.log(`뉴스레터 발송 완료: ${result.count}명`);
    } catch (err) {
      console.error('[newsletter]', err.message);
    }
  }
  console.log(`브리핑 생성 ${items.length}건 / Sheets 신규 저장 ${savedCount}건 완료`);
  return items;
}

function mergeBriefingItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!isRelevantBriefingItem(item)) return false;
    const keys = getBriefingDedupKeys(item);
    const key = keys[0] || normalizeText(`${item.title} ${item.link}`);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

async function fetchBriefingFromClaude(env) {
  const today = getKSTDateStr();

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || 'claude-sonnet-4-6',
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
            `각 항목의 title, summary, source, link, image는 반드시 같은 원문/검색결과에서 가져와. 서로 다른 기사나 검색결과의 제목과 URL을 섞지 마.\n` +
            `link는 title/summary의 근거가 되는 실제 원문 URL이어야 하며, 확신이 없으면 그 항목은 제외해. 제목은 과장 없이 간결하게 작성.\n` +
            `JSON 형식으로만 반환 (다른 텍스트 없이 배열만):\n` +
            `[{"date":"YYYY-MM-DD","category":"카테고리명","title":"제목","summary":"2-3문장 요약","source":"출처명","link":"URL","image":"이미지 URL 또는 빈 문자열"}]`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    if (res.status === 403 && /Request not allowed/i.test(err)) {
      console.warn('[briefing-cron] Anthropic web_search not allowed. Falling back to feed-based briefing.');
      return fetchBriefingFromFeeds(env, today);
    }
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

// ─── Anthropic web_search 권한이 없을 때 쓰는 한국어 뉴스 fallback ─────────────

const BRIEFING_FEED_QUERIES = [
  '대학 온라인 교육 콘텐츠 제작',
  '대학 원격교육 이러닝 스튜디오',
  '공공기관 AI 교육 플랫폼 SW 개발',
  '대학 XR 실감형 콘텐츠 구축',
  '교육부 에듀테크 개인정보 보안',
  'AI 모델 국내 공식 블로그',
  'AX 전환 대학 기관 교육',
];

async function fetchBriefingFromFeeds(env, today) {
  const candidates = await fetchKoreanNewsCandidates();
  if (!candidates.length) {
    throw new Error('Anthropic web_search 권한이 없고, fallback 뉴스 후보도 찾지 못했습니다.');
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content:
            `오늘 날짜(${today}) 기준 브리핑에 넣을 최신 정보 5~8개를 아래 후보 목록에서만 골라줘.\n` +
            `우리는 대학·기관 대상으로 온라인 교육 콘텐츠 제작, 스튜디오 구축, SW 개발을 하는 회사다.\n` +
            `선정 기준: 최근 7일 이내, 한국어 출처 우선, 대학/기관 영업·제안·사업기회 관련성, AI/AX/에듀테크/SW/스튜디오/XR 관련성.\n` +
            `카테고리별로 억지로 하나씩 맞추지 말고, 최신성과 적합성이 높은 항목을 우선해.\n` +
            `link는 후보의 link를 그대로 사용하고, date는 브리핑 발행일인 ${today}로 통일해.\n` +
            `summary는 후보 제목/설명만 근거로 과장 없이 2문장으로 작성해.\n` +
            `JSON 배열만 반환해. 다른 설명은 쓰지 마.\n` +
            `[{"date":"YYYY-MM-DD","category":"카테고리명","title":"제목","summary":"2문장 요약","source":"출처명","link":"URL","image":""}]\n\n` +
            `후보 목록:\n${JSON.stringify(candidates.slice(0, 40))}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    if (res.status === 403 && /Request not allowed/i.test(err)) {
      console.warn('[briefing-cron] Anthropic fallback not allowed. Using deterministic feed summary.');
      return buildBriefingFromCandidates(candidates, today);
    }
    throw new Error(`Claude API fallback ${res.status}: ${err}`);
  }

  const data = await res.json();
  if (data.stop_reason !== 'end_turn') {
    throw new Error(`Claude API fallback 응답 미완료: stop_reason=${data.stop_reason}`);
  }

  const text = data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('fallback 응답에서 JSON 배열을 찾을 수 없음');

  const items = JSON.parse(match[0]);
  if (!Array.isArray(items)) throw new Error('Claude fallback 응답이 JSON 배열이 아님');
  return items;
}

function buildBriefingFromCandidates(candidates, today) {
  const selected = candidates
    .filter((item) => item.title && item.link)
    .slice(0, 8)
    .map((item) => ({
      date: today,
      category: inferBriefingCategory(`${item.title} ${item.description}`),
      title: cleanBriefingTitle(item.title),
      summary: buildCandidateSummary(item),
      source: item.source || '뉴스',
      link: item.link,
      image: item.image || '',
    }));

  if (!selected.length) {
    throw new Error('fallback 후보는 찾았지만 브리핑 항목으로 변환할 수 없습니다.');
  }
  return selected;
}

function inferBriefingCategory(text) {
  const value = String(text || '').toLowerCase();
  if (/xr|실감|메타버스|스튜디오|영상|콘텐츠|크리에이터|k-콘텐츠/i.test(value)) return '스튜디오·콘텐츠';
  if (/개인정보|보안|사이버|실태점검/i.test(value)) return '에듀테크 보안';
  if (/lms|플랫폼|sw|소프트웨어|서비스|솔루션|시스템/i.test(value)) return '교육 플랫폼·SW';
  if (/mooc|원격|이러닝|온라인|평생교육|강좌/i.test(value)) return '온라인 교육';
  if (/ai|인공지능|생성형|모델|ax/i.test(value)) return 'AI·AX 트렌드';
  if (/대학|교육부|공공기관|정부|사업|지원/i.test(value)) return '교육정책·기관';
  return '브리핑';
}

function cleanBriefingTitle(title) {
  return decodeEntities(String(title || '')
    .replace(/\s+-\s+[^-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim());
}

function buildCandidateSummary(item) {
  const description = cleanBriefingTitle(item.description || '');
  if (description) {
    return truncateText(description, 150);
  }
  return `${item.source || '관련 출처'}에서 공개한 최신 소식입니다. 대학·기관 대상 콘텐츠 제작, 교육 플랫폼, AI·AX 전환 관점에서 확인할 만한 항목입니다.`;
}

async function fetchKoreanNewsCandidates() {
  const feeds = buildNewsFeedUrls();

  const results = await Promise.allSettled(feeds.map(fetchNewsFeed));
  const items = results
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value);

  const seen = new Set();
  return items
    .filter((item) => isRecentNewsDate(item.publishedAt))
    .filter((item) => {
      const key = normalizeText(item.title || item.link);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 60);
}

function buildGoogleNewsFeedUrls() {
  return BRIEFING_FEED_QUERIES.map((query) => {
    const q = `${query} when:7d`;
    return {
      provider: 'google',
      query,
      url: `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`,
    };
  });
}

function buildBingNewsFeedUrls() {
  return BRIEFING_FEED_QUERIES.map((query) => ({
    provider: 'bing',
    query,
    url: `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&cc=KR&setlang=ko-KR`,
  }));
}

function buildNewsFeedUrls() {
  return [
    ...buildGoogleNewsFeedUrls(),
    ...buildBingNewsFeedUrls(),
  ];
}

async function fetchNewsFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 XEMI Briefing Bot',
        Accept: 'application/rss+xml,text/xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseNewsFeedItems(xml, feed.provider);
  } catch (_) {
    return [];
  }
}

async function fetchNewsFeedDebug(feed) {
  const res = await fetch(feed.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 XEMI Briefing Bot',
      Accept: 'application/rss+xml,text/xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
  });
  const text = await res.text();
  const parsed = parseNewsFeedItems(text, feed.provider);
  return {
    provider: feed.provider,
    query: feed.query,
    ok: res.ok,
    status: res.status,
    length: text.length,
    itemTags: (text.match(/<item\b/gi) || []).length,
    parsed: parsed.length,
    sampleTitle: parsed[0]?.title || '',
    sampleDate: parsed[0]?.publishedAt || '',
  };
}

async function debugKoreanNewsCandidates() {
  const feeds = buildNewsFeedUrls();
  const results = await Promise.allSettled(feeds.map(fetchNewsFeedDebug));
  const feedsDebug = results.map((result, index) => (
    result.status === 'fulfilled'
      ? result.value
      : {
        provider: feeds[index]?.provider || '',
        query: feeds[index]?.query || '',
        error: result.reason?.message || String(result.reason),
      }
  ));
  const candidates = await fetchKoreanNewsCandidates();
  return {
    totalCandidates: candidates.length,
    feeds: feedsDebug,
    sample: candidates.slice(0, 5),
  };
}

async function fetchGoogleNewsFeed(feedUrl) {
  return fetchNewsFeed({ provider: 'google', query: '', url: feedUrl });
}

function parseNewsFeedItems(xml, provider = 'google') {
  return [...String(xml || '').matchAll(/<item\b[\s\S]*?<\/item>/gi)]
    .map((match) => {
      const block = match[0];
      return {
        title: cleanFeedText(pickXmlTag(block, 'title')),
        link: normalizeFeedLink(cleanFeedText(pickXmlTag(block, 'link')), provider),
        source: cleanFeedText(pickXmlTag(block, provider === 'bing' ? 'News:Source' : 'source')) || (provider === 'bing' ? 'Bing News' : 'Google News'),
        description: truncateText(cleanFeedText(pickXmlTag(block, 'description')), 180),
        publishedAt: cleanFeedText(pickXmlTag(block, 'pubDate')),
        image: cleanFeedText(pickXmlTag(block, provider === 'bing' ? 'News:Image' : 'media:content')),
      };
    })
    .filter((item) => item.title && looksLikeUrl(item.link));
}

function normalizeFeedLink(link, provider) {
  const clean = decodeEntities(link);
  if (provider !== 'bing') return clean;
  try {
    const url = new URL(clean);
    const original = url.searchParams.get('url');
    return original ? decodeURIComponent(original) : clean;
  } catch (_) {
    return clean;
  }
}

function pickXmlTag(block, tagName) {
  const match = String(block || '').match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? match[1] : '';
}

function cleanFeedText(value) {
  return decodeEntities(String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function isRecentNewsDate(value) {
  if (!value) return true;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return true;
  return Date.now() - time <= 8 * 24 * 60 * 60 * 1000;
}

// ─── 기사 대표 이미지 자동 추출 ─────────────────────────────────────────────

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
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

function pickMetaTitle(html) {
  const patterns = [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:title["'][^>]*>/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return cleanFeedText(match[1]);
  }
  return '';
}

function fallbackImage(category, seed = '') {
  const images = {
    ai: [
      'https://images.unsplash.com/photo-1485827404703-89b55fcc595e?w=1200&q=80',
      'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=1200&q=80',
      'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=1200&q=80',
    ],
    elearning: [
      'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=1200&q=80',
      'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=1200&q=80',
      'https://images.unsplash.com/photo-1509062522246-3755977927d7?w=1200&q=80',
    ],
    policy: [
      'https://images.unsplash.com/photo-1523050854058-8df90110c9f1?w=1200&q=80',
      'https://images.unsplash.com/photo-1450101499163-c8848c66ca85?w=1200&q=80',
      'https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=1200&q=80',
    ],
    studio: [
      'https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=1200&q=80',
      'https://images.unsplash.com/photo-1497366754035-f200968a6e72?w=1200&q=80',
      'https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?w=1200&q=80',
    ],
    xr: [
      'https://images.unsplash.com/photo-1622979135225-d2ba269cf1ac?w=1200&q=80',
      'https://images.unsplash.com/photo-1593508512255-86ab42a8e620?w=1200&q=80',
      'https://images.unsplash.com/photo-1617802690992-15d93263d3a9?w=1200&q=80',
    ],
    platform: [
      'https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=1200&q=80',
      'https://images.unsplash.com/photo-1551434678-e076c223a692?w=1200&q=80',
      'https://images.unsplash.com/photo-1553877522-43269d4ea984?w=1200&q=80',
    ],
    default: [
      'https://images.unsplash.com/photo-1497366754035-f200968a6e72?w=1200&q=80',
      'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=1200&q=80',
      'https://images.unsplash.com/photo-1523240795612-9a054b0db644?w=1200&q=80',
    ],
  };
  const key = fallbackImageGroup(category);
  const choices = images[key] || images.default;
  return choices[stableIndex(`${category}|${seed}`, choices.length)];
}

function fallbackImageGroup(category) {
  const text = String(category || '').toLowerCase();
  if (/xr|실감|메타버스|가상/.test(text)) return 'xr';
  if (/스튜디오|콘텐츠|영상|제작/.test(text)) return 'studio';
  if (/lms|플랫폼|sw|소프트웨어|에듀테크/.test(text)) return 'platform';
  if (/원격|이러닝|온라인|강좌|교육/.test(text)) return 'elearning';
  if (/정책|공공|정부|교육부|사업|재정/.test(text)) return 'policy';
  if (/ai|ax|gemini|gpt|모델/.test(text)) return 'ai';
  return 'default';
}

function stableIndex(value, length) {
  let hash = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % Math.max(length, 1);
}

async function fetchArticleImage(link) {
  if (!link) return '';
  try {
    const pageUrl = new URL(link);
    if (!/^https?:$/.test(pageUrl.protocol)) return '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(pageUrl.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 XEMI Briefing Bot',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return '';
    const html = await res.text();
    return pickMetaImage(html.slice(0, 200000), pageUrl.href);
  } catch (_) {
    return '';
  }
}

async function fetchArticlePreview(link) {
  if (!link) return { title: '', image: '' };
  try {
    const pageUrl = new URL(link);
    if (!/^https?:$/.test(pageUrl.protocol)) return { title: '', image: '' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(pageUrl.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 XEMI Briefing Bot',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return { title: '', image: '' };
    const html = (await res.text()).slice(0, 200000);
    return {
      title: pickMetaTitle(html),
      image: pickMetaImage(html, pageUrl.href),
    };
  } catch (_) {
    return { title: '', image: '' };
  }
}

async function enrichBriefingImages(items) {
  const enriched = await Promise.all(items.map(async (item) => {
    const preview = await fetchArticlePreview(item.link);
    if (preview.title && !isMatchingArticleTitle(item, preview.title)) {
      console.warn(`[briefing-cron] link/title mismatch skipped: ${item.title} -> ${preview.title}`);
      return null;
    }
    const image = item.image || preview.image || (await fetchArticleImage(item.link));
    return { ...item, image: image || fallbackImage(item.category, item.title || item.link) };
  }));
  return enriched.filter(Boolean);
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
  const existingKeys = await readExistingBriefingKeys(env, token);
  const incomingKeys = new Set();
  const filteredItems = items.filter((item) => isRelevantBriefingItem(item)).filter((item) => {
    const keys = getBriefingDedupKeys(item);
    if (!keys.length || keys.some((key) => existingKeys.has(key) || incomingKeys.has(key))) return false;
    keys.forEach((key) => incomingKeys.add(key));
    return true;
  });

  if (!filteredItems.length) return 0;

  const values = filteredItems.map((item) => [
    item.date ?? '',
    item.category ?? '',
    item.title ?? '',
    item.summary ?? '',
    item.source ?? '',
    item.link ?? '',
    item.image ?? fallbackImage(item.category, item.title || item.link),
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

  return filteredItems.length;
}

async function readExistingBriefingKeys(env, token) {
  const range = encodeURIComponent(getBriefingRange(env, 2));
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) return new Set();

  const data = await res.json();
  return new Set((data.values ?? [])
    .flatMap(([date, category, title, summary, source, link]) => getBriefingDedupKeys({ date, title, link }))
    .filter(Boolean));
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
    image: normalizeBriefingImage(image, category, `${title || ''} ${link || ''}`),
    status: normalizeBriefingStatus(status),
  })).filter((item) => !isPlaceholderBriefing(item) && isPublishedBriefing(item) && isRelevantBriefingItem(item));

  const seen = new Set();
  const deduped = rows.reverse().filter((item) => {
    const keys = getBriefingDedupKeys(item);
    if (!keys.length || keys.some((key) => seen.has(key))) return false;
    keys.forEach((key) => seen.add(key));
    return true;
  }).reverse();

  const byDate = new Map();
  for (const item of deduped) {
    const date = String(item.date || '').trim();
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(item);
  }

  return Array.from(byDate.entries())
    .sort(([dateA], [dateB]) => String(dateB).localeCompare(String(dateA)))
    .flatMap(([, items]) => items.slice(-8).reverse());
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

function normalizeBriefingImage(image, category, seed = '') {
  const value = String(image || '').trim();
  if (!value || isLegacyFallbackImage(value)) return fallbackImage(category, seed);
  return value;
}

function isLegacyFallbackImage(value) {
  return [
    'photo-1497366754035-f200968a6e72',
    'photo-1485827404703-89b55fcc595e',
    'photo-1677442136019-21780ecad995',
    'photo-1516321318423-f06f85e504b3',
    'photo-1523050854058-8df90110c9f1',
    'photo-1554224155-6726b3ff858f',
    'photo-1519389950473-47ba0277781c',
  ].some((needle) => String(value || '').includes(needle));
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

function pickBriefingTeasers(items) {
  return pickNewsletterItems(items).slice(0, 3);
}

function pickCurationTeasers(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && item.title && item.url)
    .slice()
    .reverse()
    .filter((item, index, arr) => {
      const key = `${item.type || ''}|${item.url || ''}|${item.title || ''}`;
      return arr.findIndex((other) => `${other.type || ''}|${other.url || ''}|${other.title || ''}` === key) === index;
    })
    .slice(0, 3);
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
      image: fallbackImage('AI', '대학 온라인 교육 현장에 생성형 AI 활용 확대'),
    },
    {
      date: today,
      category: '콘텐츠 제작',
      title: '실감형 스튜디오와 온라인 콘텐츠 고도화 수요 증가',
      summary: '대학·기관의 스튜디오 구축, XR 콘텐츠, 영상 기반 교육 자산 관리 수요가 이어지고 있습니다. 구축 이후 운영 체계와 콘텐츠 제작 워크플로우까지 함께 제안하는 접근이 중요합니다.',
      source: 'XEMIRO Briefing',
      link: 'https://xemi.co.kr/',
      image: fallbackImage('스튜디오', '실감형 스튜디오와 온라인 콘텐츠 고도화 수요 증가'),
    },
    {
      date: today,
      category: '정책 · 공공',
      title: '교육 플랫폼과 개인정보보호 기준 점검 필요',
      summary: 'LMS, 교육 플랫폼, 학습 데이터 활용이 늘면서 개인정보보호와 보안 기준이 제안 평가의 핵심 요소로 부상하고 있습니다. 개발·운영 제안서에 보안 체계를 명확히 반영할 필요가 있습니다.',
      source: 'XEMIRO Briefing',
      link: 'https://xemi.co.kr/',
      image: fallbackImage('보안', '교육 플랫폼과 개인정보보호 기준 점검 필요'),
    },
  ];
}

function sampleCurationItems() {
  return [
    {
      type: 'youtube',
      title: 'AI 영상 제작 워크플로우 정리',
      desc: '기관 홍보·교육 콘텐츠 제작에 참고할 만한 AI 영상 제작 흐름을 짧게 큐레이션했습니다.',
      url: 'https://xemiro.pages.dev/curation.html',
      image: fallbackImage('AI', 'AI 영상 제작 워크플로우 정리'),
    },
    {
      type: 'seminar',
      title: '교육·에듀테크 세미나',
      desc: '대학·공공기관 제안과 사업기회 탐색에 참고할 만한 행사입니다.',
      url: 'https://xemiro.pages.dev/curation.html',
      image: fallbackImage('seminar', '교육 에듀테크 세미나'),
    },
  ];
}

function renderNewsletterHtml(items, options = {}) {
  const briefings = pickBriefingTeasers(items);
  const curations = pickCurationTeasers(options.curationItems || []);
  const today = getKSTDateStr();
  const subject = `${today} XEMIRO Briefing`;
  const previewNotice = options.error
    ? `<div style="margin:0 auto 16px;max-width:760px;padding:12px 16px;border-radius:12px;background:#fff3cd;color:#5f4300;font-size:13px;">시트 데이터를 불러오지 못해 샘플로 표시합니다: ${escapeHtml(options.error)}</div>`
    : '';
  const briefingCards = briefings.map((item) => renderNewsletterCard(item, 'briefing')).join('');
  const curationCards = curations.map((item) => renderNewsletterCard(normalizeCurationForNewsletter(item), 'curation')).join('');

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
        <h1 style="margin:12px 0 10px;font-size:32px;line-height:1.25;letter-spacing:-.02em;">오늘 볼 만한 것만 살짝</h1>
        <p style="margin:0;font-size:15px;line-height:1.7;color:rgba(255,255,255,.82);">대학·기관 콘텐츠 제작, 스튜디오 구축, SW 개발 관점에서 놓치면 아쉬운 소식과 큐레이션을 골랐습니다.</p>
        <div style="margin-top:22px;display:inline-block;padding:8px 13px;border-radius:999px;background:rgba(255,255,255,.16);font-size:13px;">${escapeHtml(today)}</div>
      </section>
      <section style="padding:26px 24px 4px;">
        ${renderNewsletterSectionTitle('최신 브리핑', '핵심만 짧게 보고, 자세한 내용은 재미로에서 이어서 확인하세요.')}
        ${briefingCards || renderEmptyNewsletter()}
      </section>
      <section style="padding:8px 24px 4px;">
        ${renderNewsletterSectionTitle('추천 큐레이션', '영상, 도서, 세미나까지 업무에 참고할 만한 자료를 함께 담았습니다.')}
        ${curationCards || renderEmptyNewsletter()}
      </section>
      <section style="padding:8px 34px 30px;">
        <a href="${escapeHtml(envAwareHomeUrl())}" style="display:block;text-align:center;text-decoration:none;border-radius:14px;background:#94442e;color:#fff;padding:15px 18px;font-weight:700;font-size:14px;">재미로에서 전체 보기 →</a>
        <div style="margin-top:12px;text-align:center;font-size:12px;">
          <a href="${escapeHtml(envAwareBriefingUrl())}" style="color:#94442e;text-decoration:none;font-weight:700;">브리핑</a>
          <span style="color:#c8b8aa;margin:0 8px;">|</span>
          <a href="${escapeHtml(envAwareCurationUrl())}" style="color:#94442e;text-decoration:none;font-weight:700;">큐레이션</a>
        </div>
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

function renderNewsletterSectionTitle(title, desc) {
  return `<div style="margin:0 0 14px;padding:0 2px;">
    <h2 style="margin:0;font-size:18px;line-height:1.35;color:#2d2926;">${escapeHtml(title)}</h2>
    <p style="margin:5px 0 0;font-size:13px;line-height:1.6;color:#77645d;">${escapeHtml(desc)}</p>
  </div>`;
}

function renderNewsletterCard(item, kind = 'briefing') {
  const image = item.image || fallbackImage(item.category, item.title || item.link);
  const url = kind === 'curation' ? envAwareCurationUrl() : envAwareBriefingUrl();
  const action = kind === 'curation' ? '큐레이션에서 보기 →' : '자세히 보기 →';
  return `<article style="display:block;margin:0 0 14px;border:1px solid #eaded2;border-radius:16px;overflow:hidden;background:#fff;">
    ${image ? `<a href="${escapeHtml(url)}" target="_blank" style="display:block;height:132px;background:#f5efe8;overflow:hidden;"><img src="${escapeHtml(image)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;"></a>` : ''}
    <div style="padding:16px 18px 18px;">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
        <span style="display:inline-block;padding:5px 9px;border-radius:999px;background:#f5e9e2;color:#94442e;font-size:12px;font-weight:700;">${escapeHtml(item.category)}</span>
        <span style="font-size:12px;color:#8a7770;">${escapeHtml(item.source || '')}</span>
      </div>
      <h3 style="margin:0 0 8px;font-size:19px;line-height:1.36;letter-spacing:-.02em;color:#2d2926;">${escapeHtml(item.title)}</h3>
      <p style="margin:0 0 14px;font-size:13px;line-height:1.65;color:#55433e;">${escapeHtml(truncateText(item.summary || '', 92))}</p>
      <a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;color:#94442e;text-decoration:none;font-size:13px;font-weight:700;">${action}</a>
    </div>
  </article>`;
}

function renderEmptyNewsletter() {
  return '<div style="padding:28px;border:1px dashed #d8c8ba;border-radius:16px;color:#77645d;text-align:center;">아직 발송할 브리핑이 없습니다.</div>';
}

function normalizeCurationForNewsletter(item) {
  const labels = { youtube: 'YouTube', book: '도서', seminar: '세미나' };
  return {
    category: labels[item.type] || '큐레이션',
    title: item.title || '',
    summary: item.desc || '재미로 큐레이션에서 이어서 확인해보세요.',
    source: 'XEMIRO Curation',
    link: item.url || envAwareCurationUrl(),
    image: item.image || fallbackImage(item.type, item.title || item.url),
  };
}

async function readCurationCards(env) {
  requireEnv(env, ['GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT']);
  const sa = readServiceAccount(env);
  const token = await getAccessToken(sa);
  const auth = { Authorization: `Bearer ${token}` };
  const names = await getSheetNames(env.GOOGLE_SHEET_ID, auth);
  const candidates = uniqueStrings([env.CURATION_SHEET_NAME, env.GOOGLE_SHEET_NAME, '시트1', 'Sheet1', ...names]);
  let best = [];
  for (const name of candidates) {
    try {
      const cards = await readCurationCardsFromSheet(env.GOOGLE_SHEET_ID, auth, name);
      if (cards.length > best.length) best = cards;
    } catch (_) {}
  }
  return best;
}

async function getSheetNames(sheetId, auth) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`, {
    headers: auth,
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.sheets || []).map((sheet) => sheet.properties.title).filter(Boolean);
}

async function readCurationCardsFromSheet(sheetId, auth, sheetName) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`${sheetName}!A1:Z`)}`,
    { headers: auth }
  );
  if (!res.ok) throw new Error(`큐레이션 시트 읽기 실패: ${sheetName}`);
  const data = await res.json();
  return valuesToCurationCards(data.values || []);
}

function valuesToCurationCards(values) {
  if (!Array.isArray(values) || !values.length) return [];
  const first = values[0] || [];
  const hasHeader = looksLikeCurationHeader(first);
  const start = hasHeader ? 1 : 0;
  const header = hasHeader ? {
    type: findHeaderIndex(first, ['type', '유형', '분류', '카테고리']),
    url: findHeaderIndex(first, ['url', 'link', '링크', '주소']),
    title: findHeaderIndex(first, ['title', '제목']),
    desc: findHeaderIndex(first, ['desc', 'description', '요약', '설명', '내용']),
    image: findHeaderIndex(first, ['image', 'thumbnail', '썸네일', '이미지']),
  } : null;

  return values.slice(start)
    .map((row, index) => rowToCurationCard(row || [], start + index + 1, header))
    .filter((card) => card.title && card.url && normalizeText(card.title) !== 'title' && normalizeText(card.title) !== '제목');
}

function rowToCurationCard(row, rowNumber, header) {
  const byHeader = (key, fallback) => header && header[key] !== -1 && row[header[key]] !== undefined ? row[header[key]] : row[fallback];
  let card = {
    rowNumber,
    type: normalizeCurationType(byHeader('type', 0)),
    url: byHeader('url', 1) || '',
    title: byHeader('title', 2) || '',
    desc: byHeader('desc', 3) || '',
    image: byHeader('image', 4) || '',
  };
  if (!card.title && row[0] && looksLikeUrl(row[1])) {
    card = {
      rowNumber,
      type: normalizeCurationType(row[3] || ''),
      url: row[1] || '',
      title: row[0] || '',
      desc: row[2] || '',
      image: row[4] || '',
    };
  }
  return {
    ...card,
    url: String(card.url || '').trim(),
    title: String(card.title || '').trim(),
    desc: String(card.desc || '').trim(),
    image: String(card.image || '').trim(),
  };
}

function looksLikeCurationHeader(row) {
  const normalized = (row || []).map(normalizeText);
  return ['type', 'url', 'title', '제목', '링크'].some((name) => normalized.includes(normalizeText(name)));
}

function findHeaderIndex(headers, names) {
  const normalizedNames = names.map(normalizeText);
  for (let i = 0; i < headers.length; i += 1) {
    if (normalizedNames.includes(normalizeText(headers[i]))) return i;
  }
  return -1;
}

function normalizeCurationType(value) {
  const type = normalizeText(value);
  if (['book', '도서'].includes(type)) return 'book';
  if (['seminar', '세미나', 'event', '행사'].includes(type)) return 'seminar';
  return 'youtube';
}

async function sendNewsletter(env, items, options = {}) {
  requireEnv(env, ['RESEND_API_KEY']);
  const recipients = parseRecipients(env.NEWSLETTER_RECIPIENTS || env.NEWSLETTER_TEST_RECIPIENTS);
  if (!recipients.length) throw new Error('NEWSLETTER_RECIPIENTS 환경변수가 필요합니다');

  const picked = pickBriefingTeasers(items);
  const curationItems = options.curationItems || [];
  const today = getKSTDateStr();
  const subject = options.test ? `[TEST] ${today} XEMIRO Briefing` : `${today} XEMIRO Briefing`;
  const from = env.NEWSLETTER_FROM || 'XEMIRO Briefing <onboarding@resend.dev>';
  const html = renderNewsletterHtml(picked, { curationItems });

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

function envAwareCurationUrl() {
  return 'https://xemiro.pages.dev/curation.html';
}

function envAwareHomeUrl() {
  return 'https://xemiro.pages.dev/';
}

function truncateText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.filter((value) => {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function isMatchingArticleTitle(item, pageTitle) {
  const itemTitle = cleanBriefingTitle(item?.title || '');
  const actualTitle = cleanBriefingTitle(pageTitle);
  const itemTitleKey = normalizeText(itemTitle);
  const actualTitleKey = normalizeText(actualTitle);
  if (itemTitleKey && actualTitleKey && (itemTitleKey.includes(actualTitleKey) || actualTitleKey.includes(itemTitleKey))) {
    return true;
  }

  const titleTokens = briefingTitleTokens(itemTitle);
  const actualTitleTokens = briefingTitleTokens(actualTitle);
  if (!titleTokens.length || !actualTitleTokens.length) return true;

  const actualTitleSet = new Set(actualTitleTokens);
  const titleShared = titleTokens.filter((token) => actualTitleSet.has(token));
  const titleMeaningfulShared = titleShared.filter((token) => token.length >= 3 || /\d/.test(token));
  const titleRatio = titleShared.length / Math.min(titleTokens.length, actualTitleTokens.length);
  if (titleMeaningfulShared.length >= 2 || (titleMeaningfulShared.length >= 1 && titleRatio >= 0.35)) {
    return true;
  }

  const expected = briefingTitleTokens(`${itemTitle} ${item?.summary || ''}`);
  const actual = briefingTitleTokens(pageTitle);
  if (!expected.length || !actual.length) return true;

  const actualSet = new Set(actual);
  const shared = expected.filter((token) => actualSet.has(token));
  const meaningfulShared = shared.filter((token) => token.length >= 3 || /\d/.test(token));
  const ratio = shared.length / Math.min(expected.length, actual.length);
  return meaningfulShared.length >= 3 && ratio >= 0.42;
}

function briefingTitleTokens(value) {
  const stopwords = new Set([
    '관련', '최신', '기반', '활용', '위한', '대한', '통해', '에서', '으로', '하고',
    '및', '등', '뉴스', '기사', '보도', '공개', '발표', '선정', '추진',
  ]);
  const tokens = cleanBriefingTitle(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .match(/[가-힣a-z0-9]+/g) || [];
  return [...new Set(tokens
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stopwords.has(token)))];
}

function isRelevantBriefingItem(item) {
  const text = `${item?.category || ''} ${item?.title || ''} ${item?.summary || ''} ${item?.source || ''}`.toLowerCase();
  const hardReject = [
    /주식|증시|테마주|수혜주|약세|강세|상한가|하한가/,
    /피지컬\s*ai|로봇|월드모델|국산화\s*도전/,
    /반도체|전력\s*솔루션|배터리|자동차|공장|제조\s*공정|cfd|simcenter/,
    /홈쇼핑|쇼핑엔티|여행방송/,
    /개인정보|보안|침해|유출|과징금|cpo|개인정보보호/,
    /클래스팅\s*블로그|blog\.classting\.com\/2026checklist/,
  ];
  if (hardReject.some((pattern) => pattern.test(text))) return false;

  const audience = /대학|교육|학교|교원|학생|학습|강의|고등교육|공공|기관|정부|교육부|keris|직무교육|훈련|인재원/.test(text);
  const service = /콘텐츠|온라인|원격|이러닝|lms|플랫폼|sw|소프트웨어|에듀테크|스튜디오|xr|실감|메타버스|ai\s*교육|디지털\s*교육|강좌|커리큘럼|mooc/.test(text);
  const officialAi = /구글코리아|openai|anthropic|google|gemini|claude|gpt/.test(text)
    && /교육|콘텐츠|플랫폼|개발|업무도구|자동화|강의|학습/.test(text);

  return (audience && service) || officialAi;
}

function isStronglyRelevantBriefingItem(item) {
  const text = `${item?.category || ''} ${item?.title || ''} ${item?.summary || ''} ${item?.source || ''}`.toLowerCase();
  const institution = /대학|교육부|keris|한국교육학술정보원|공공기관|인재원|학교|고등교육/.test(text);
  const coreWork = /원격교육|이러닝|lms|온라인콘텐츠|온라인\s*교육|강좌|커리큘럼|교육\s*플랫폼|스튜디오|xr|실감형|메타버스|콘텐츠\s*제작|ai\s*융합형\s*교육실/.test(text);
  return institution && coreWork;
}

function getBriefingDedupKeys(item) {
  const date = String(item?.date || '').trim();
  const linkKey = normalizeBriefingUrl(item?.link);
  const titleKey = normalizeBriefingTitleForDedup(item?.title);
  return [
    linkKey ? `${date}|url|${linkKey}` : '',
    titleKey ? `${date}|title|${titleKey}` : '',
  ].filter(Boolean);
}

function normalizeBriefingUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const params = new URLSearchParams();
    [...url.searchParams.entries()]
      .filter(([key]) => !/^(utm_|fbclid$|gclid$|yclid$|igshid$|mc_cid$|mc_eid$)/i.test(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([key, val]) => params.append(key, val));

    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const query = params.toString();
    return `${url.protocol}//${host}${pathname}${query ? `?${query}` : ''}`;
  } catch (_) {
    return normalizeText(raw);
  }
}

function normalizeBriefingTitleForDedup(value) {
  return normalizeText(cleanBriefingTitle(value)
    .replace(/[“”"'‘’]/g, '')
    .replace(/\[[^\]]+\]|\([^)]+\)$/g, ''));
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
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
