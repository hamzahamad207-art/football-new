// Image fetcher — uses the free Openverse API (https://api.openverse.org)
// to get CC-licensed soccer photos. No API key required (rate-limited per
// IP, which is fine for our usage).
//
// Openverse returns publicly-hosted image URLs that the Threads Graph API
// can download. Arabic-only topic text is translated to a short English
// query via a keyword table (Arabic keywords return poor Openverse results).
//
// Variety & reliability:
//   - candidates are shuffled (so the same photo isn't picked every run),
//   - known off-topic photos (e.g. the "green mascot man") are blacklisted,
//   - every candidate URL is validated as a directly-fetchable image file,
//   - several queries are tried before giving up.

const BASE_QUERIES = {
  news: 'football soccer match action photo',
  stats: 'football player celebrating goal',
  analysis: 'football tactics formation pitch',
  meme: 'soccer fan funny reaction',
  throwback: 'classic football legend retro',
  fact: 'football stadium crowd atmosphere',
  quote: 'football legend black and white portrait',
};

// Flickr photo IDs that Openverse keeps ranking for broad "football" queries
// but are off-topic (green mascot man in a stadium, etc.).
const BLOCKED_IDS = new Set(['4071294803']);

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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Extract a Flickr photo id from a URL, if present. */
function flickrId(url) {
  const m = url.match(/\/(\d{6,})_[a-z0-9]+\.(?:jpg|jpeg|png|gif)/i);
  return m ? m[1] : null;
}

/** Skip known off-topic photos (like the green mascot man). */
function isBlocked(url) {
  const id = flickrId(url);
  return id ? BLOCKED_IDS.has(id) : false;
}

/**
 * Query Openverse for soccer photos matching the query.
 * Returns an array of candidate image URLs (file URLs + thumbnails, deduped).
 */
export async function searchImage(query) {
  console.log(`🖼️  Openverse search: ${query}`);

  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=20&mature=false`;

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
      for (const u of [r?.url, r?.thumbnail]) {
        if (typeof u === 'string' && /^https:\/\//i.test(u) && !seen.has(u)) {
          seen.add(u);
          urls.push(u);
        }
      }
      if (urls.length >= 20) break;
    }
    return urls;
  } catch (err) {
    console.warn(`⚠️  Openverse search failed: ${err.message?.slice(0, 100)}`);
    return [];
  }
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
      if (!ct.startsWith('image/')) continue;
      // Compute the full size: content-range total, else content-length.
      let size = NaN;
      const cr = res.headers.get('content-range'); // e.g. "bytes 0-2047/123456"
      const crMatch = cr && cr.match(/\/(\d+)$/);
      if (crMatch) {
        size = Number(crMatch[1]);
      } else {
        const cl = Number(res.headers.get('content-length'));
        if (Number.isFinite(cl) && cl > 0) size = cl;
      }
      // Reject tiny files (icons, avatars, logos) when we know the size.
      if (Number.isFinite(size) && size > 0 && size < 12000) continue;
      return true;
    } catch (err) {
      /* try the next method */
    }
  }
  return false;
}

/**
 * Pick the best image for the given content type + context, trying several
 * queries, skipping blacklisted photos, and validating that the chosen URL is
 * a real, fetchable image. Results are shuffled so posts vary.
 * Returns { imageUrl } or { imageUrl: null } if none found.
 */
export async function pickImageForContent(type, ctx) {
  // 1) Prefer the REAL photos from the article itself (og:image / JSON-LD —
  //    usually the actual match photo, not a generic stock shot).
  const articleCandidates =
    Array.isArray(ctx?.articleImages) && ctx.articleImages.length
      ? ctx.articleImages
      : ctx?.articleImage
        ? [ctx.articleImage]
        : [];
  for (const url of articleCandidates) {
    if (!/^https:\/\//i.test(url)) continue;
    if (await isValidImageUrl(url)) {
      console.log(`🖼️  Image URL (from article): ${url}`);
      return { imageUrl: url };
    }
  }
  if (articleCandidates.length) {
    console.log(`⚠️  ${articleCandidates.length} article image(s) not fetchable — trying real stock photos.`);
  }

  // 2) Stock search: real CC photos from Flickr/Wikimedia etc. — never AI art.
  const queries = [];
  const primary = buildImageQuery(type, ctx);
  queries.push(primary);
  for (const q of [BASE_QUERIES[type], 'football soccer match', 'soccer stadium crowd']) {
    if (q && !queries.includes(q)) queries.push(q);
  }

  const tried = new Set();
  for (const q of queries) {
    let urls = (await searchImage(q)).filter((u) => !isBlocked(u));
    if (!urls.length) {
      console.warn(`⚠️  Query "${q}" had no usable (non-blacklisted) candidates.`);
      continue;
    }
    urls = shuffle(urls);
    let checked = 0;
    for (const url of urls) {
      if (tried.has(url)) continue;
      tried.add(url);
      if (await isValidImageUrl(url)) {
        console.log(`🖼️  Image URL: ${url}`);
        return { imageUrl: url };
      }
      if (++checked >= 6) break; // don't burn the whole run validating
    }
  }

  console.warn('⚠️  No valid image found after all queries.');
  return { imageUrl: null };
}