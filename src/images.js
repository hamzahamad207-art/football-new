// Image fetcher — uses the free Openverse API (https://api.openverse.org)
// to get CC-licensed soccer photos. No API key required (rate-limited per
// IP, which is fine for our usage).
//
// Openverse returns publicly-hosted image URLs that the Threads Graph API
// can download. Arabic-only topic text is translated to a short English
// query via a keyword table (Arabic keywords return poor Openverse results).

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
 * The topic is appended as English keywords when translatable.
 */
function buildImageQuery(type, ctx) {
  const base = BASE_QUERIES[type] || 'soccer football';
  const latin = toEnglishKeywords(ctx?.topic);
  return latin ? `${base} ${latin}` : base;
}

/**
 * Query Openverse for soccer photos matching the query.
 * Returns array of image URLs (publicly hosted).
 */
export async function searchImage(query) {
  console.log(`🖼️  Openverse search: ${query}`);

  // Openverse requires URL-encoded query
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=5&mature=false`;

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

    // Prefer Flickr's "static" CDN URLs — they're reliable, HTTPS, and
    // Threads can fetch them. Filter for publicly reachable image URLs.
    const urls = results
      .map((r) => r.url)
      .filter((u) => typeof u === 'string' && /^https:\/\//i.test(u));

    return urls.slice(0, 5);
  } catch (err) {
    console.warn(`⚠️  Openverse search failed: ${err.message?.slice(0, 100)}`);
    return [];
  }
}

/**
 * Pick the best image for the given content type + context.
 * Returns { imageUrl } or { imageUrl: null } if none found.
 */
export async function pickImageForContent(type, ctx) {
  const query = buildImageQuery(type, ctx);
  const urls = await searchImage(query);
  if (!urls.length) {
    console.warn('⚠️  No image found. Post will be text-only.');
    return { imageUrl: null };
  }
  console.log(`🖼️  Image URL: ${urls[0]}`);
  return { imageUrl: urls[0] };
}