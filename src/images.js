// Image fetcher — uses the free Openverse API (https://api.openverse.org)
// to get CC-licensed soccer photos. No API key required (rate-limited per
// IP, which is fine for our usage).
//
// Openverse returns publicly-hosted image URLs that the Threads Graph API
// can download. Arabic-only topic text is translated to a short English
// query via a keyword table (Arabic keywords return poor Openverse results).
//
// Image picking is layered so a post almost never ships without a photo:
//   1. match-specific query (both team names) for "news" runs,
//   2. the content-type base query,
//   3. a generic football query,
// and every candidate URL is validated as a directly-fetchable image file
// before it's accepted (Threads can't download HTML pages).

const BASE_QUERIES = {
  news: 'football soccer match action photo',
  stats: 'football player celebrating goal',
  analysis: 'football tactics formation pitch',
  meme: 'soccer fan funny reaction',
  throwback: 'classic football legend retro',
  fact: 'football stadium crowd atmosphere',
  quote: 'football legend black and white portrait',
};

// Common Arabic football terms → English. Longer/more specific phrases come
// first so replaceAll() prefers the best match ("رونالدينيو" before "رونالدو").
const AR_TO_EN = {
  'دوري أبطال أوروبا': 'Champions League',
  'كأس العالم': 'World Cup',
  'الدوري الإنجليزي الممتاز': 'Premier League',
  'دوري روشن السعودي': 'Saudi Pro League',
  'مانشستر سيتي': 'Manchester City',
  'مانشستر يونايتد': 'Manchester United',
  'ريال مدريد': 'Real Madrid',
  'باريس سان جيرمان': 'Paris Saint-Germain',
  'بايرن ميونخ': 'Bayern Munich',
  'إنتر ميلان': 'Inter Milan',
  'برشلونة': 'Barcelona',
  'ليفربول': 'Liverpool',
  'تشيلسي': 'Chelsea',
  'أرسنال': 'Arsenal',
  'يوفنتوس': 'Juventus',
  'ميلان': 'AC Milan',
  'الهلال': 'Al-Hilal',
  'النصر': 'Al-Nassr',
  'الأهلي': 'Al-Ahli',
  'الاتحاد': 'Al-Ittihad',
  'رونالدينيو': 'Ronaldinho',
  'غوارديولا': 'Guardiola',
  'مارادونا': 'Maradona',
  'فينيسيوس': 'Vinicius',
  'هالاند': 'Erling Haaland',
  'رونالدو': 'Cristiano Ronaldo',
  'مبابي': 'Mbappe',
  'ميسي': 'Messi',
  'صلاح': 'Salah',
  'زيدان': 'Zidane',
};

/**
 * Roughly translate an Arabic topic into English keywords for Openverse.
 * Returns '' when nothing useful can be extracted (pure Arabic text).
 */
function toEnglishKeywords(topic) {
  if (!topic) return '';
  let q = String(topic);
  for (const [ar, en] of Object.entries(AR_TO_EN)) q = q.replaceAll(ar, en);
  // Drop everything non-Latin so Openverse never receives Arabic text.
  return q
    .replace(/[^\x00-\x7F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the English Openverse query for this content type.
 * News runs carrying a match-up (both team names) get the most specific
 * query; otherwise the topic is appended as English keywords if translatable.
 */
function buildImageQuery(type, ctx) {
  if (type === 'news' && ctx?.matchUp) {
    return `${ctx.matchUp} football soccer match`;
  }
  const base = BASE_QUERIES[type] || 'soccer football';
  const latin = toEnglishKeywords(ctx?.topic);
  return latin ? `${base} ${latin}` : base;
}

/**
 * Query Openverse for soccer photos matching the query.
 * Returns an array of candidate image URLs (file URLs + thumbnails, deduped).
 */
export async function searchImage(query) {
  console.log(`🖼️  Openverse search: ${query}`);

  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=10&mature=false`;

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      console.warn(`⚠️  Openverse returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    const results = data?.results || [];

    if (results.length === 0) {
      console.warn('⚠️  Openverse returned no results.');
      return [];
    }

    const seen = new Set();
    const urls = [];
    for (const r of results) {
      // r.url is the source file; r.thumbnail is a small hosted preview.
      for (const u of [r?.url, r?.thumbnail]) {
        if (typeof u === 'string' && /^https:\/\//i.test(u) && !seen.has(u)) {
          seen.add(u);
          urls.push(u);
        }
      }
      if (urls.length >= 12) break;
    }
    return urls;
  } catch (err) {
    console.warn(`⚠️  Openverse search failed: ${err.message?.slice(0, 100)}`);
    return [];
  }
}

// Prefer CDNs that reliably serve raw image bytes (Flickr static etc.).
function urlScore(url) {
  if (/live\.staticflickr\.com/i.test(url)) return 0;
  if (/staticflickr\.com/i.test(url)) return 1;
  if (/upload\.wikimedia\.org|commons\.wikimedia/i.test(url)) return 1;
  if (/images\.unsplash\.com|i\.ibb\.co|pixabay\.com/i.test(url)) return 2;
  return 9;
}

/**
 * Verify the URL actually responds as an image file (HEAD first, then a tiny
 * GET range). Threads needs a direct, download-able image — an HTML page
 * would make the post fail.
 */
async function isValidImageUrl(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
        headers: { Range: 'bytes=0-2047' },
      });
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (ct.startsWith('image/')) return true;
    } catch (err) {
      /* try the next method */
    }
  }
  return false;
}

/**
 * Pick the best image for the given content type + context, trying several
 * queries and validating that the chosen URL is a real, fetchable image.
 * Returns { imageUrl } or { imageUrl: null } if none found.
 */
export async function pickImageForContent(type, ctx) {
  const queries = [];
  const primary = buildImageQuery(type, ctx);
  queries.push(primary);
  for (const q of [BASE_QUERIES[type], 'football soccer match'] ) {
    if (q && !queries.includes(q)) queries.push(q);
  }

  const tried = new Set();
  for (const q of queries) {
    const urls = await searchImage(q);
    const ranked = urls.sort((a, b) => urlScore(a) - urlScore(b));
    let checked = 0;
    for (const url of ranked) {
      if (tried.has(url)) continue;
      tried.add(url);
      if (await isValidImageUrl(url)) {
        console.log(`🖼️  Image URL: ${url}`);
        return { imageUrl: url };
      }
      if (++checked >= 4) break; // don't burn the whole run validating
    }
    if (urls.length) {
      console.warn(`⚠️  No valid image from query "${q}".`);
    }
  }

  console.warn('⚠️  No valid image found after all queries.');
  return { imageUrl: null };
}