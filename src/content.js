// Content generator — picks a topic (the newest live/results headline for
// "news", otherwise a canned topic) and writes Khaleeji Arabic post text via
// an OpenAI-compatible chat-completions API.
//
// Uses these env vars (all required for LLM, set in GitHub Secrets):
//   LLM_API_KEY   — your Z.ai API key (https://z.ai → API Keys)
//   LLM_BASE_URL  — defaults to "https://api.z.ai/api/paas/v4"
//   LLM_MODEL     — defaults to "glm-4.5-flash" (free tier, good Arabic)
//
// Works with any OpenAI-compatible endpoint (Groq, OpenAI, OpenRouter, etc.)
// by overriding LLM_BASE_URL + LLM_MODEL.

import { TEMPLATES, FALLBACK_TOPICS, LEAGUES, pickRandom } from './templates.js';

const DEFAULT_BASE_URL = 'https://api.z.ai/api/paas/v4';
const DEFAULT_MODEL = 'glm-4.7-flash';

// Live / recent / upcoming match data — ESPN's public scoreboard API (no key).
const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const ESPN_LEAGUES = [
  'eng.1', 'esp.1', 'ita.1', 'bund.1', 'fra.1', 'ksa.1',
  'uefa.champions', 'uefa.europa',
];

// Trending-headline sources — authentic football outlets, no API keys needed.
// BBC Arabic is deliberately NOT here: its feed carries general/politics news,
// not sports, so including it risks non-football posts.
const NEWS_FEEDS = {
  'BBC Sport': { kind: 'rss', url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
  'Sky Sports': { kind: 'rss', url: 'https://www.skysports.com/rss/12040' },
  'Google News': {
    kind: 'rss',
    url: 'https://news.google.com/rss/search?q=soccer+results&hl=en-GB&gl=GB&ceid=GB:en',
  },
};

// Aggregators also surface non-soccer items (politics, "American football",
// other sports). Filter each title to football vocabulary only, with both
// English and Arabic teams (e.g. "دوري", "مباراة", "فريق").
const FOOTBALL_RE =
  /football|soccer|premier\s*league|champions\s*league|europa\s*league|la\s*liga|laliga|bundesliga|serie\s*a\s?|ligue\s*1|world\s*cup|derby|transfer|sign(?:ing|ed)|goal|match|league|cup|manager|striker|midfielder|defender|goalkeep|coach|ronaldo|messi|mbappe|haaland|salah|barcelona|real\s*madrid|man(?:chester|\.?\s?u|\.?\s?c|.?u|.?c|utd|city)|arsenal|liverpool|chelsea|bayern|psg|juventus|milan|inter|tottenham|newcastle|aston\s*villa|sevilla|atletico|napoli|dortmund|دوري|مباراة|كرة|فريق|هداف|لاعب|نادي|ملعب|برشلونة|ريال|ليغا|بريميرليج|الهلال|النصر|الأهلي|الاتحاد|ليفربول|مانشستر|تشيلسي|أرسنال|ميسي|رونالدو|مبابي|صلاح|هالاند|انتصار|فوز|تعادل|هزيمة/i;

// American "football" is a completely different sport — kill anything that
// smells like NFL / NCAA / SEC / US college gridiron before it can become a
// soccer post (their headlines often still contain the word "football").
const AMERICAN_FOOTBALL_RE =
  /\bnfl\b|\bncaa\b|\bsec\b|\bbig ten\b|\bbig 12\b|\bpac-?12\b|\bacc\b|super bowl|college (?:football|sports)|quarterback|touchdown|offensive lineman|kick-?off (?:time|times)?|american football|texas a&m|kentucky|alabama|ohio state|georgia bulldogs|clemson|auburn|notre dame|cfb playoff/i;

function llmConfig() {
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL || DEFAULT_BASE_URL;
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;
  if (!apiKey) {
    throw new Error(
      `LLM_API_KEY env var is not set. Get a free key at https://z.ai → API Keys, ` +
      `then add it as a GitHub Secret named LLM_API_KEY.`
    );
  }
  return { apiKey, baseUrl, model };
}

/** Strip XML/CDATA/entities noise out of an RSS/HTML title or snippet. */
function cleanXmlTitle(raw) {
  return String(raw)
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize to a seconds or ms epoch timestamp, else -Infinity. */
function toEpoch(v) {
  if (!v) return -Infinity;
  const n = Number(v);
  return Number.isFinite(n) ? n : -Infinity;
}

/** Fetch + parse an RSS feed into [{ title, url, description, image, date }]. */
async function fetchRssItems(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
      'User-Agent': 'TouchlineARBot/2.0 (Threads football page)',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);

  const xml = await res.text();
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  const titleRe = /<title>([\s\S]*?)<\/title>/i;
  const dateRe = /<pubDate>([\s\S]*?)<\/pubDate>/i;
  const linkRe = /<link>([\s\S]*?)<\/link>/i;
  const descRe = /<description>([\s\S]*?)<\/description>/i;
  const mediaRe = /<media:content[^>]+url=["']([^"']+)["']/i;
  const encRe = /<enclosure[^>]+url=["']([^"']+)["']/i;
  const imgRe = /<img[^>]+src=["']([^"']+)["']/i;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const t = titleRe.exec(block);
    if (!t || !t[1]) continue;
    const title = cleanXmlTitle(t[1]);
    if (!title) continue;

    const d = dateRe.exec(block);
    const dm = descRe.exec(block);
    const description = dm && dm[1] ? cleanXmlTitle(dm[1]).slice(0, 420) : '';

    // Image candidates: media:content > enclosure > first <img> in description.
    const media = mediaRe.exec(block);
    const enc = encRe.exec(block);
    const ig = imgRe.exec(block);
    const image = media && media[1] ? media[1] : enc && enc[1] ? enc[1] : ig && ig[1] ? ig[1] : '';

    const lk = linkRe.exec(block);
    items.push({
      title,
      date: d && d[1] ? Date.parse(d[1]) : -Infinity,
      url: lk && lk[1] ? cleanXmlTitle(lk[1]) : '',
      description,
      image,
    });
  }
  return items;
}

/** Fetch ESPN's soccer news JSON into [{ title, url, description, image, date }]. */
async function fetchEspnNews(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'TouchlineARBot/2.0' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`ESPN news HTTP ${res.status}`);
  const data = await res.json();
  return (data.articles || [])
    .map((a) => {
      const description = cleanXmlTitle(a.description || a.headline || '').slice(0, 420);
      return {
        title: cleanXmlTitle(a.headline || ''),
        date: toEpoch(a.published),
        url: a.links?.web?.href || '',
        description,
        image: Array.isArray(a.images) && a.images[0]?.url ? a.images[0].url : '',
      };
    })
    .filter((a) => a.title);
}

/**
 * Enrich an article item from its page: collect the article's REAL photos
 * (all og:image metas + JSON-LD images) and its summary (meta description or
 * JSON-LD articleBody). Never fails the run — keeps whatever the feed gave us
 * when the page is unreachable.
 */
async function enrichArticle(item) {
  const out = { ...item, images: item.images || [] };
  if ((!out.url || !/^https:\/\//i.test(out.url)) && !out.images.length) return out;
  try {
    const res = await fetch(out.url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,*/*',
        'User-Agent': 'TouchlineARBot/2.0 (Threads football page)',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return out;
    const html = await res.text();

    // 1) Photos: every og:image meta (in page order) + JSON-LD image entries.
    const imgUrls = [];
    const imgRe = /<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/gi;
    let m2;
    while ((m2 = imgRe.exec(html)) !== null) {
      if (/^https:\/\//i.test(m2[1])) imgUrls.push(m2[1]);
    }
    const revImgRe = /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/gi;
    while ((m2 = revImgRe.exec(html)) !== null) {
      if (/^https:\/\//i.test(m2[1])) imgUrls.push(m2[1]);
    }
    const ldScript = html.match(/<script type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (ldScript) {
      try {
        const parsed = JSON.parse(ldScript[1]);
        const art = Array.isArray(parsed)
          ? parsed.find((p) => p && /(?:News)?Article/.test(p['@type'] || ''))
          : parsed;
        const img = art?.image || art?.thumbnailUrl || [];
        const list = Array.isArray(img) ? img : [img];
        for (const i of list) {
          const u = typeof i === 'string' ? i : i?.url;
          if (typeof u === 'string' && /^https:\/\//i.test(u)) imgUrls.push(u);
        }
      } catch (err) {
        /* bad JSON — ignore */
      }
    }
    for (const u of imgUrls) {
      if (!out.images.includes(u)) out.images.push(u);
    }
    if (out.images.length > 6) out.images.length = 6;

    // 2) Summary: meta description → else JSON-LD articleBody/description.
    const descMeta =
      html.match(
        /<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]+content=["']([^"']+)["']/i
      ) ||
      html.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:description|description)["']/i
      );
    if (descMeta && descMeta[1]) {
      const d = cleanXmlTitle(descMeta[1]);
      if (!out.description || out.description.length < 60) out.description = d.slice(0, 420);
    }
    if (ldScript) {
      try {
        const parsed = JSON.parse(ldScript[1]);
        const art = Array.isArray(parsed)
          ? parsed.find((p) => p && /(?:News)?Article/.test(p['@type'] || ''))
          : parsed;
        if (art?.articleBody && !out.description) {
          out.description = cleanXmlTitle(art.articleBody).slice(0, 420);
        }
      } catch (err) {
        /* ignore */
      }
    }
    out.description = cleanXmlTitle(out.description).slice(0, 420);
  } catch (err) {
    /* article page unreachable — keep feed-provided data */
  }
  if (typeof out.title === 'string') {
    // Trim the trailing " - Publisher" suffix Google News appends to titles.
    out.title = cleanXmlTitle(out.title)
      .replace(/\s+[-–]\s+[\p{L}\p{N}]{2,40}$/u, '')
      .trim();
    out.scoreHeader = scoreHeaderFromTitle(out.title);
  }
  return out;
}

/**
 * Fetch the most trending/latest football headlines from authentic outlets
 * (ESPN, Sky Sports, BBC Sport, BBC Arabic + the Google News aggregator) in
 * parallel. Dedupes by normalized title and returns the newest unique items as
 * [{ title, url, description, image, date, source }], newest first. Returns []
 * on total failure — the caller then fails cleanly instead of posting
 * stale/guessed material.
 */
async function fetchTrendingHeadlines() {
  const settled = await Promise.allSettled(
    Object.entries(NEWS_FEEDS).map(async ([name, feed]) => {
      const items =
        feed.kind === 'json' ? await fetchEspnNews(feed.url) : await fetchRssItems(feed.url);
      return { name, items };
    })
  );

  const seen = new Set();
  const all = [];
  for (const r of settled) {
    if (r.status !== 'fulfilled') {
      console.warn(`⚠️  News feed failed: ${r.reason?.message?.slice(0, 80) || 'unknown'}`);
      continue;
    }
    const { name, items } = r.value;
    const now = Date.now();
    for (const it of items) {
      // Only the genuinely latest: drop items without a date or older than 24h.
      if (!Number.isFinite(it.date) || now - it.date > 24 * 3600e3) continue;
      // BBC/Sky are football-scoped feeds — trust them (only drop gridiron).
      // Google News is a general aggregator: require football vocab and block
      // American-football stories, so politics/college gridiron can never
      // become a soccer post.
      if (name === 'Google News') {
        if (!FOOTBALL_RE.test(it.title) || AMERICAN_FOOTBALL_RE.test(it.title)) continue;
      } else if (AMERICAN_FOOTBALL_RE.test(it.title)) {
        continue;
      }
      const key = it.title
        .toLowerCase()
        .replace(/[^a-z0-9\u0600-\u06FF\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      all.push({
        title: it.title,
        date: it.date,
        source: name,
        url: it.url || '',
        description: it.description || '',
        image: it.image || '',
      });
    }
  }

  // Truly latest first.
  all.sort((a, b) => b.date - a.date);

  const top = all.slice(0, 10);
  if (top.length) {
    console.log(
      `🌐 Trending headlines: ${top.length} newest unique items ` +
        `(sources: ${[...new Set(top.map((i) => i.source))].join(', ')})`
    );
  }
  return top;
}

/**
 * Fetch matches from ESPN's public scoreboard for the major leagues.
 * Returns a flat array of normalized matches: label, state (pre/in/post),
 * score, minute detail, recap text, kick-off date.
 */
async function fetchCurrentMatches() {
  const settled = await Promise.allSettled(
    ESPN_LEAGUES.map(async (league) => {
      const res = await fetch(`${ESPN_SCOREBOARD}/${league}/scoreboard`, {
        headers: { Accept: 'application/json', 'User-Agent': 'TouchlineARBot/2.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const out = [];
      for (const ev of data.events || []) {
        const comp = ev.competitions?.[0];
        const st = comp?.status?.type;
        if (!st || !comp) continue;
        const home = comp.competitors?.find((c) => c.homeAway === 'home');
        const away = comp.competitors?.find((c) => c.homeAway === 'away');
        const label =
          home && away
            ? `${home.team?.displayName} vs ${away.team?.displayName}`
            : ev.name || 'Football match';
        const score =
          home?.score !== undefined && away?.score !== undefined
            ? `${home.score} - ${away.score}`
            : '';
        out.push({
          league,
          id: ev.id,
          label,
          homeName: home?.team?.displayName || '',
          awayName: away?.team?.displayName || '',
          homeScore: home?.score,
          awayScore: away?.score,
          state: st.state, // 'pre' | 'in' | 'post'
          detail: st.shortDetail || '', // e.g. "67'", "FT"
          score,
          summary: comp.headlines?.[0]?.description || '', // recap sentence
          date: new Date(ev.date),
        });
      }
      return out;
    })
  );
  return settled.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
}

/**
 * Pick the most interesting match right now:
 * 1) any match in progress (live), 2) the latest finished match with a recap,
 * 3) the next kick-off. Returns {match, tag} or null.
 */
function pickBestMatch(matches) {
  const now = Date.now();
  const live = matches.filter((m) => m.state === 'in');
  if (live.length) return { match: live[0], tag: 'live' };

  const finished = matches
    .filter((m) => m.state === 'post' && now - m.date.getTime() < 48 * 3600e3)
    .sort((a, b) => b.date - a.date);
  if (finished.length) {
    const withSummary = finished.find((m) => m.summary) || finished[0];
    return { match: withSummary, tag: 'recent' };
  }

  const upcoming = matches
    .filter((m) => m.state === 'pre' && m.date.getTime() > now)
    .sort((a, b) => a.date - b.date);
  if (upcoming.length) return { match: upcoming[0], tag: 'upcoming' };
  return null;
}

/**
 * Deterministic Arabic result sentence built from ESPN's score fields —
 * the model can't "decide" who won, it only reports what the API said.
 */
function resultArabic(m) {
  const hs = m.homeScore;
  const as = m.awayScore;
  const hasScore = hs !== undefined && hs !== null && as !== undefined && as !== null;
  if (!hasScore) return `انتهت مباراة ${m.label}.`;
  if (String(hs) === String(as)) return `انتهت مباراة ${m.label} بالتعادل ${hs} - ${as}.`;
  const homeWon = Number(hs) > Number(as);
  const winner = homeWon ? m.homeName : m.awayName;
  const loser = homeWon ? m.awayName : m.homeName;
  const score = homeWon ? `${hs} - ${as}` : `${as} - ${hs}`;
  return `فاز ${winner} على ${loser} بنتيجة ${score}.`;
}

/**
 * Pull the REAL facts of a finished/live match from ESPN's play-by-play
 * summary: goals + scorers with minutes + venue. This is what makes a post
 * interesting ("Salah 23', Díaz 66' at Anfield") instead of "the game ended,
 * what do you think?". Returns '' when unavailable.
 */
async function fetchMatchFacts(m) {
  if (!m?.id || !m?.league) return '';
  try {
    const url = `${ESPN_SCOREBOARD}/${m.league}/summary?event=${m.id}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'TouchlineARBot/2.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const data = await res.json();

    const scorers = [];
    for (const e of data.keyEvents || []) {
      if (e.scoringPlay !== true) continue;
      const minute = (e.clock?.displayValue || '')
        .replace(/^0/, '')
        .replace(/:\d+$/, '');
      const scorer = e.athletes?.[0]?.displayName || '';
      const team = e.team?.displayName || '';
      scorers.push(`${scorer} ${minute ? minute + "'" : ''}${team ? ` (${team})` : ''}`.trim());
      if (scorers.length >= 6) break;
    }

    const venue = data.header?.competitions?.[0]?.venue?.fullName || '';
    const bits = [];
    if (scorers.length) bits.push(`أهداف: ${scorers.join('، ')}`);
    if (venue) bits.push(`الملعب: ${venue}`);
    return bits.join(' · ');
  } catch (err) {
    return '';
  }
}

/**
 * Find the FRESHEST news article/report about a specific match (e.g. tonight's
 * "Barcelona vs Sevilla") via a Google News query scoped to the last ~26h and
 * filtered to titles mentioning either team. Prefers articles that read like
 * reports (result words / scores). Returns title, real summary + the article's
 * photos — or null when nothing fresh is found.
 */
async function fetchMatchArticle(matchUp, teamNames) {
  const names = teamNames.filter(Boolean);
  const query =
    `${matchUp ? `"${matchUp}" ` : ''}${names.map((t) => `"${t}"`).join(' ')} result`.trim();
  if (!query) return null;
  const feedUrl =
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
    `&hl=en-GB&gl=GB&ceid=GB:en`;

  try {
    const items = await fetchRssItems(feedUrl);
    const now = Date.now();
    const lowerNames = names.map((t) => t.toLowerCase());

    const candidates = items
      .filter((it) => Number.isFinite(it.date) && now - it.date < 26 * 3600e3)
      .filter((it) => {
        const lower = it.title.toLowerCase();
        return lowerNames.some((n) => n && lower.includes(n));
      })
      // Drop pre-match noise: previews, predictions, betting/odds, how-to-watch,
      // plus anything that smells like American gridiron.
      .filter(
        (it) =>
          !(
            /(prediction|betting|tips?|odds|preview|how to watch|stream|kick-?off|build-?up|predicted lineup|время)/i.test(
              it.title
            ) || AMERICAN_FOOTBALL_RE.test(it.title)
          )
      )
      .sort((a, b) => b.date - a.date);

    if (!candidates.length) return null;

    // Enrich the top few candidates; a real scoreline in the title is the
    // strongest signal (post-match result), then a real article summary
    // (Google News sometimes returns boilerplate text instead).
    const genericRe = /comprehensive up-to-date|google news|powered by|coverage of/i;
    const enrichedList = await Promise.all(candidates.slice(0, 3).map((c) => enrichArticle(c)));
    const best =
      enrichedList.find((e) => e.scoreHeader) ||
      enrichedList.find(
        (e) => (e.description || '').length >= 60 && !genericRe.test(e.description)
      ) ||
      enrichedList[0];

    // Never feed boilerplate summaries to the caption model.
    const description =
      best.description && genericRe.test(best.description) ? '' : best.description || '';

    console.log(`🗞️ Fresh article about this match (${best.title.slice(0, 80)}...)`);

    return {
      title: best.title,
      description,
      images: best.images || [],
      image: (best.images || [])[0] || '',
      url: best.url || '',
      scoreHeader: best.scoreHeader || null,
    };
  } catch (err) {
    return null;
  }
}

/**
 * If an article title is shaped like a scoreline ("Sevilla FC 1 - 3 FC
 * Barcelona | ..."), build the deterministic TouchlineX FT header from the
 * real result. Returns null otherwise.
 */
function scoreHeaderFromTitle(raw) {
  let t = String(raw || '').replace(/\s*[|:\u2014\u2015]\s.*$/u, '').trim();
  // Strip a trailing " - Source" suffix (after the last team name).
  t = t.replace(/\s+[-–]\s+[\p{L}\p{N}]{2,40}$/u, '').trim();
  const m = t.match(/^(.{2,40}?)\s+(\d{1,2})\s*[-–—]\s*(\d{1,2})\s+(.{2,40})$/);
  if (!m) return null;
  return `FT: ${m[1].trim()} ${m[2]} - ${m[3]} ${m[4].trim()}`;
}

/**
 * Split a typed topic like "Barcelona vs Sevilla" / "البارسا ضد ريال" into
 * the most specific team keywords (last word of each side).
 */
function extractTeamKeywords(override) {
  return String(override)
    .split(/\s+(?:vs\.?|ver\.?|v\.?|ضد|مع)\s+|\s+[-–—]\s+/i)
    .map((side) => side.trim())
    .filter(Boolean)
    .map((side) => {
      const words = side.split(/\s+/).filter((w) => /^[A-Za-z\u0600-\u06FF]/.test(w));
      return words[words.length - 1] || side;
    })
    .filter((w) => w && w.length >= 3)
    .slice(0, 2);
}

/**
 * Turn a raw ESPN match + tag into the {topic, header, matchUp, facts, recap,
 * summary} context used by all templates. `header` is a deterministic
 * TouchlineX-style line (LIVE/FT/NEXT) the model must copy verbatim — it can't
 * invent a score or a different match. `facts` holds real on-pitch detail
 * (scorers/minutes/venue), `recap` the API recap sentence.
 */
async function annotateMatch(m, tag) {
  const matchUp = `${m.awayName || ''} ${m.homeName || ''}`.trim() || m.label;
  const hs = m.score ? m.score.split(' - ')[0] : '?';
  const as = m.score ? m.score.split(' - ')[1] : '?';

  let header;
  if (tag === 'live') {
    const minute = /\d+/.test(m.detail) ? ` ${m.detail}` : '';
    header = `LIVE: ${m.homeName} ${hs} - ${as} ${m.awayName}${minute}`;
  } else if (tag === 'recent') {
    header = `FT: ${m.homeName} ${hs} - ${as} ${m.awayName}`;
  } else {
    header = `NEXT: ${m.label}`;
  }

  const facts = tag === 'live' || tag === 'recent' ? await fetchMatchFacts(m) : '';

  return {
    topic: m.label,
    matchUp,
    homeName: m.homeName,
    awayName: m.awayName,
    header,
    facts,
    recap: m.summary || '',
    summary: resultArabic(m),
  };
}

/**
 * Build a {topic, header, matchUp, recap, summary} context for the current/
 * ongoing match so "news" posts are real-time and factually anchored.
 */
async function getLiveMatchContext() {
  try {
    const matches = await fetchCurrentMatches();
    const pick = pickBestMatch(matches);
    if (!pick) return null;
    const m = pick.match;
    if (pick.tag === 'live') console.log(`🔴 Live match: ${m.label} ${m.score} (${m.detail})`);
    if (pick.tag === 'recent') console.log(`📰 Latest result: ${m.label} ${m.score}`);
    if (pick.tag === 'upcoming') console.log(`📅 Next match: ${m.label}`);
    return await annotateMatch(m, pick.tag);
  } catch (err) {
    console.warn(`⚠️  Could not fetch live matches (${err.message}).`);
    return null;
  }
}

/**
 * Try to resolve a user-typed topic (e.g. "Barcelona vs Sevilla") against the
 * live ESPN fixtures so the post carries the REAL score/happening instead of
 * the model guessing. Returns the annotated context or null if no fixture
 * matches.
 */
async function findMatchForTopic(override) {
  try {
    const matches = await fetchCurrentMatches();
    const tokens = override.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);

    const hit = matches.find((m) => {
      const nameBroad = `${m.homeName} ${m.awayName} ${m.label}`.toLowerCase();
      if (tokens.some((t) => nameBroad.includes(t))) return true;
      const nameParts = [m.homeName, m.awayName].map((n) => n.toLowerCase()).filter(Boolean);
      return nameParts.filter((n) => tokens.some((t) => n.includes(t) || t.includes(n))).length >= 2;
    });

    if (!hit) return null;
    const tag = hit.state === 'in' ? 'live' : hit.state === 'post' ? 'recent' : 'upcoming';
    console.log(`🎯 Topic matched a live fixture → ${tag}`);
    return await annotateMatch(hit, tag);
  } catch (err) {
    console.warn(`⚠️  Could not search matches for topic (${err.message}).`);
    return null;
  }
}

/**
 * Resolve the topic for this run.
 *   - A --topic / BOT_TOPIC override always wins.
 *   - "news" with no topic → current/ongoing match (live → latest result →
 *     next fixture) → else a trending headline from ESPN/Sky/BBC/Google News
 *     (with the article's own summary + photo when available). Never canned
 *     topics (that's what let the model invent "Copa del Rey final" style
 *     garbage) — if no fresh data at all, the run fails cleanly instead.
 * Returns { topic, header, summary }.
 */
export async function fetchNewsContext(type, opts = {}) {
  const override = (opts.topicOverride || '').trim();

  if (override) {
    // 1) Real fixture from ESPN's scoreboard — when its API is reachable.
    const found = await findMatchForTopic(override);
    if (found) {
      // Attach the freshest article about that exact matchup (summary + photo).
      const art = await fetchMatchArticle(found.matchUp, [found.homeName, found.awayName]);
      if (art) {
        found.recap = art.description || found.recap;
        found.articleImage = art.image || null;
        found.articleImages = art.images || [];
        found.articleUrl = art.url || '';
      }
      return found;
    }
    // 2) ESPN unreachable (403s on many networks, incl. some runners) — fall
    //    back to the freshest real article about this matchup instead of
    //    letting the model guess.
    const names = extractTeamKeywords(override);
    const art = names.length ? await fetchMatchArticle('', names) : null;
    if (art) {
      console.log(`🎯 Topic override (no ESPN) → fresh article: ${art.title.slice(0, 70)}...`);
      return {
        topic: art.title,
        matchUp: names.join(' '),
        homeName: names[0] || '',
        awayName: names[1] || '',
        header: art.scoreHeader || `📰 ${art.title}`,
        recap: art.description || '',
        articleImage: art.image || null,
        articleImages: art.images || [],
        articleUrl: art.url || '',
        summary: '',
      };
    }
    console.log(`🎯 Topic override (no live fixture found): "${override}"`);
    return { topic: override, header: `🚨 ${override}`, recap: '', summary: '' };
  }

  // Real-time content whenever it's available — not just for "news".
  if (type === 'news' || type === 'stats' || type === 'analysis') {
    const live = await getLiveMatchContext();
    if (live) {
      // For news posts about a just-finished/live match, attach the FRESHEST
      // article about that exact matchup: its summary (feeds the caption) and
      // its own photos (feed the image) — real, current, from the game played
      // recently, not a dated generic stock shot.
      if (type === 'news') {
        const art = await fetchMatchArticle(live.matchUp, [live.homeName, live.awayName]);
        if (art) {
          live.recap = art.description || live.recap;
          live.articleImage = art.image || null;
          live.articleImages = art.images || [];
          live.articleUrl = art.url || '';
        }
      }
      if (live.facts) console.log(`⚽ Match facts: ${live.facts.slice(0, 160)}${live.facts.length > 160 ? '…' : ''}`);
      if (live.articleImage) console.log(`🗞️ Article photo attached for this match.`);
      return live;
    }
  }

  if (type === 'news') {
    const headlines = await fetchTrendingHeadlines();
    if (headlines.length) {
      // Pick one story, then enrich it with the article's own summary + photos.
      // Prefer established outlets (BBC Sport, Sky Sports) over the Google
      // aggregator, which also surfaces niche US/local roundups.
      const preferred = headlines
        .slice(0, 8)
        .filter((i) => i.source === 'BBC Sport' || i.source === 'Sky Sports');
      const item = preferred.length
        ? pickRandom(preferred.slice(0, 4))
        : pickRandom(headlines.slice(0, 5));
      const article = await enrichArticle(item);
      console.log(`📰 Trending headline picked: ${article.title} (${article.source || 'feed'})`);
      if (article.description) {
        console.log(
          `   Article summary: ${article.description.slice(0, 140)}${article.description.length > 140 ? '…' : ''}`
        );
      }
      return {
        topic: article.title,
        header: article.scoreHeader || `📰 ${article.title}`,
        recap: article.description || '',
        articleImage: (article.images || [])[0] || null,
        articleImages: article.images || [],
        articleUrl: article.url || '',
        source: article.source || '',
      };
    }

    throw new Error(
      `No current match data and no fresh article available right now. ` +
      `Try again later, or run with a specific --topic.`
    );
  }

  const topic = pickRandom(FALLBACK_TOPICS[type]);
  console.log(`📋 Random canned topic: ${topic}`);
  return { topic, header: `🚨 ${topic}`, recap: '', summary: '' };
}

/**
 * Call an OpenAI-compatible chat-completions endpoint.
 * Defaults to Z.ai's public GLM API; can be repointed to OpenAI / Groq /
 * OpenRouter via env vars.
 */
async function chatComplete({ systemPrompt, userPrompt, temperature = 0.8 }) {
  const { apiKey, baseUrl, model } = llmConfig();
  const url = `${baseUrl}/chat/completions`;

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    max_tokens: 800,
  };

  // GLM-4.5+ models "think" by default and can spend the whole token budget
  // on reasoning_content, leaving `content` empty (what broke the first run).
  // Z.ai accepts a switch to disable thinking. Sent only for Z.ai/BigModel
  // endpoints — other OpenAI-compatible providers ignore unknown fields.
  if (/z\.ai|bigmodel/i.test(baseUrl)) body.thinking = { type: 'disabled' };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      });
    } catch (err) {
      // Network hiccup or the API taking too long — retry, same as 429s.
      if (attempt < 3) {
        const delay = [3000, 8000][attempt - 1] || 8000;
        console.warn(
          `⚠️  LLM request failed (${String(err?.message).slice(0, 60)}) — retrying in ${delay / 1000}s...`
        );
        await sleep(delay);
        continue;
      }
      throw err;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (res.status === 401) {
        throw new Error(
          `LLM API 401: token expired or incorrect. Generate a new key at ` +
          `https://z.ai → API Keys and update the LLM_API_KEY secret.`
        );
      }
      if (res.status === 404 || /model.*not.*exist|not found/i.test(errText)) {
        throw new Error(
          `LLM API 404: model "${model}" not found. Fix the LLM_MODEL secret — ` +
          `use 'glm-4.5-flash' (free) or 'glm-4.7-flash', 'glm-4.6', 'glm-5.3'. ` +
          `(API said: ${errText.slice(0, 200)})`
        );
      }
      // Transient overload / rate-limit: back off and retry.
      if (res.status === 429 || res.status >= 500) {
        if (attempt < 3) {
          const delay = [2000, 6000][attempt - 1] || 6000;
          console.warn(
            `⚠️  LLM API ${res.status} (attempt ${attempt}/3) — retrying in ${delay / 1000}s...`
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
      throw new Error(`LLM API ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (text) return text;
    console.warn(`⚠️  LLM returned empty content (attempt ${attempt}/2). Retrying...`);
  }
  throw new Error('LLM returned empty content after 2 attempts');
}

// Hard football vocabulary used by the deterministic domain check — a caption
// that contains none of these (in Arabic or common Latin tokens) isn't about
// football, no matter what the model's classifier claims.
const FOOTBALL_TERMS = [
  // Arabic core terms
  'كرة', 'مباراة', 'فريق', 'دوري', 'لاعب', 'هدف', 'أهداف', 'ملعب', 'ناد',
  'نادي', 'حكم', 'بطولة', 'كأس', 'مدرب', 'جمهور', 'مشجع', 'هجوم', 'دفاع',
  'مرمى', 'تشكيل', 'تسديدة', 'انتصار', 'فوز', 'هزيمة', 'خسارة', 'تعادل',
  'صدارة', 'نهائي', 'جولة', 'جول', 'سجل', 'كرة القدم', 'القدم',
  // League / team / player names (Arabic + Latin fallback)
  'ليجا', 'بريميرليج', 'روشن', 'دوري أبطال', 'برشلونة', 'البارسا', 'ريال',
  'الأهلي', 'الهلال', 'النصر', 'الاتحاد', 'ميسي', 'رونالدو', 'مبابي',
  'صلاح', 'هالاند', 'غوارديولا', 'أنشيلوتي', 'المضيّف', 'calendar', 'league',
  'match', 'goal', 'team', 'stadium', 'football',
];
function containsFootballVocab(text) {
  return FOOTBALL_TERMS.some((t) => text.toLowerCase().includes(t.toLowerCase()));
}

// Well-known clubs / stars / managers in Arabic + Latin forms. If a caption
// mentions one of these names but the article data doesn't, it's a
// hallucination (e.g. "مدير التشيلسي الجديد" in a story about Arsenal WSL).
// Only tracked names trigger, so unrelated words never cause false flags.
const NAMED_ENTITIES = [
  ['برشلونة', 'barcelona'],
  ['ريال', 'real madrid'],
  ['اتلتيكو', 'atletico'],
  ['اشبيلية', 'إشبيلية', 'sevilla'],
  ['ليفربول', 'liverpool'],
  ['مانشستر', 'manchester'],
  ['تشيلسي', 'تشلسي', 'chelsea'],
  ['أرسنال', 'آرسنال', 'arsenal'],
  ['توتنهام', 'سبيرز', 'tottenham', 'spurs'],
  ['نيوكاسل', 'newcastle'],
  ['أستون فيلا', 'استون فيلا', 'aston villa'],
  ['برايتون', 'brighton'],
  ['بايرن', 'bayern'],
  ['دورتموند', 'dortmund'],
  ['يوفنتوس', 'juventus'],
  ['ميلان', 'ac milan'],
  ['انتر', 'inter'],
  ['نابولي', 'napoli'],
  ['روما', 'roma'],
  ['باريس', 'psg', 'paris'],
  ['مارسيليا', 'marseille'],
  ['ليون', 'lyon'],
  ['الهلال', 'al hilal'],
  ['النصر', 'al nassr'],
  ['الأهلي', 'al ahli'],
  ['الاتحاد', 'al ittihad'],
  ['الشباب', 'al shabab'],
  ['الزمالك', 'zamalek'],
  ['بينفيكا', 'benfica'],
  ['بورتو', 'porto'],
  ['أياكس', 'ajax'],
  ['ميسي', 'messi'],
  ['رونالدو', 'ronaldo'],
  ['مبابي', 'mbappe'],
  ['صلاح', 'salah'],
  ['هالاند', 'haaland'],
  ['ليفاندوفسكي', 'levandowski'],
  ['فينيسيوس', 'vinicius'],
  ['يامال', 'yamal'],
  ['بيلينغهام', 'bellingham'],
  ['نيمار', 'neymar'],
  ['بنزيمة', 'benzema'],
  ['تشافي', 'شافي', 'xavi'],
  ['غوارديولا', 'guardiola'],
  ['أنشيلوتي', 'ancelotti'],
  ['مورينيو', 'mourinho'],
  ['كلوب', 'klopp'],
  ['أرتيتا', 'arteta'],
  ['تود بوهلي', 'todd boehly'],
];

// Normalize text for name matching: lowercase, unify Arabic letters, strip
// punctuation so "التشيلسي" matches "تشيلسي" etc.
function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^a-z\u0600-\u06FF\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns the display name of the first tracked club/star/manager that the
 * caption's body mentions WITHOUT appearing in the article data (header/
 * recap/facts) — i.e. the model invented someone. Returns null if the caption
 * is fully grounded. The header line itself is always grounded (it IS the
 * article title), so we only inspect the Khaleeji body.
 */
function findUngroundedName(text, ctx) {
  const body = String(text).replace(/^\S[^\n]*\n/, '');
  const ground = normText([ctx?.header, ctx?.recap, ctx?.facts, ctx?.topic].join(' '));
  const bodyNorm = normText(body);
  for (const pair of NAMED_ENTITIES) {
    // Only aliases ≥5 chars are tracked (avoids "ليون" matching "ليونيل",
    // "ريال"/"روما"/"ميسي" matching unrelated words).
    const aliases = pair.map((n) => normText(n)).filter((n) => n.length >= 5);
    if (!aliases.length) continue;
    const inBody = aliases.some((n) => bodyNorm.includes(n));
    if (!inBody) continue;
    const grounded = aliases.some((n) => ground.includes(n) || ground.includes(n.replace(/^ال/, '')));
    if (!grounded) {
      console.warn(`⚽ Guard: caption mentions "${pair[0]}" — absent from article data.`);
      return pair[0];
    }
  }
  return null;
}

/**
 * Domain guard for the generated caption. Two layers:
 *   1. Anchoring: if the caption starts with our own match header (FT/LIVE/
 *      NEXT/🚨/📰) it is definitively football — trust it.
 *   2. Vocabulary check — none of our football terms at all ⇒ flagged
 *      (catches the "Gen Z study habits", "military", etc. rambles).
 *   3. An LLM classifier as a second opinion.
 * Returns true (football) or false (off-topic → generation will be retried).
 */
async function isFootballOnly(text, ctx) {
  const header = ctx?.header;
  const anchored = header && /^(?:FT|LIVE|NEXT|🚨|📰)/.test(text);
  const hasVocab = anchored || containsFootballVocab(text);
  if (!hasVocab) {
    console.warn('⚽ Guard: no football vocabulary in caption — flagged.');
    return false;
  }
  // Artifact check: the Khaleeji body must contain no English words and no
  // code tokens (e.g. the "_performance" glitch). The first (header) line may
  // legitimately contain Latin team names (FT: Sevilla 1 - 3 FC Barcelona).
  const body = String(text).replace(/^\S[^\n]*\n/, '');
  if (/\b[a-zA-Z]{2,}\b/.test(body) || /_{2,}|\{\{|\}\}|```/.test(String(text))) {
    console.warn('⚽ Guard: English/code artifact in caption body — flagged.');
    return false;
  }
  // Name-grounding: any tracked club/star/manager must come from the data.
  if (findUngroundedName(text, ctx)) return false;
  try {
    const label = await chatComplete({
      systemPrompt:
        'أنت مصنف محتوى صارم. أجِب بكلمة واحدة فقط: "نعم" أو "لا". ' +
        'أجب "نعم" فقط إذا كان النص يدور بشكل واضح وغالب عن كرة القدم. وإلا أجب "لا".',
      userPrompt: `هل النص التالي عن كرة القدم فقط؟\n\n"${text.slice(0, 600)}"`,
    });
    return /نعم/.test(label);
  } catch (err) {
    console.warn(`⚠️  Guard check failed (${err.message}) — trusting vocabulary check.`);
    return hasVocab;
  }
}

/**
 * Quick deterministic quality score for a generated caption — used to pick the
 * cleaner of two independent draws. Penalizes code/English artifacts harshly,
 * rewards header faithfulness, ending on a question, an emoji and sane length.
 */
function scorePost(text, ctx) {
  const body = String(text).replace(/^\S[^\n]*\n/, '');
  if (/\b[a-zA-Z]{2,}\b/.test(body) || /_{2,}|\{\{|\}\}|```/.test(String(text))) return -999;
  let s = 0;
  const h = (ctx?.header || '').trim();
  if (h && String(text).startsWith(h.slice(0, Math.min(30, h.length)))) s += 6;
  if (/[؟?]\s*$/.test(String(text))) s += 4;
  if (/[\u{1F300}-\u{1FAFF}]/u.test(String(text))) s += 1;
  const len = String(text).length;
  if (len >= 100 && len <= 480) s += 1;
  return s;
}

/**
 * Generate the Arabic post text via the LLM, using the template's system +
 * user prompts. Returns a string (cleaned of markdown fences).
 */
export async function generatePostText(type, ctx) {
  const tpl = TEMPLATES[type];
  if (!tpl) throw new Error(`Unknown content type: ${type}`);

  console.log(`✍️  Generating ${type} post in Khaleeji Arabic...`);

  const clean = (t) =>
    t
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/```$/i, '')
      .replace(/^["'“”]|["'“”]$/g, '')
      .trim();

  const make = async (nudge, target) =>
    clean(
      await chatComplete({
        systemPrompt: tpl.systemPrompt,
        userPrompt:
          tpl.userPrompt(ctx) +
          (nudge
            ? '\n\nملاحظة: أعد كتابة المنشور حرفيًا بنفس السطر الأول، واجعل الأسطر الخليجية بالعربية فقط ' +
              '(ممنوع كلمات إنجليزية أو رموز مثل _ داخل النص)، ولا تذكر أي نادٍ/لاعب/رقم غير مذكور ' +
              'في المعلومات أعلاه، واختم دائمًا بسؤال واحد' +
              (target ? `، ولا تذكر اسم "${target}" إطلاقًا` : '') +
              '.'
            : ''),
        temperature: tpl.temperature ?? 0.8,
      })
    );

  // A guarded draw: generate, run all guards, and if flagged regenerate up to
  // 3 times — each regen explicitly bans the offending name (so a stubborn
  // hallucination like "ليفاندوفسكي" in a Barça post can't survive).
  const guardedDraw = async () => {
    let t = await make(false);
    if (tpl.footballOnly !== false) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const bad = findUngroundedName(t, ctx);
        const pass = await isFootballOnly(t, ctx); // includes the name check
        if (pass && !bad) return t;
        console.warn(`⚽ Guard: flag (${bad || 'domain'}) — regenerating (${attempt}/3)...`);
        t = await make(true, bad || undefined);
      }
      console.warn('⚽ Guard: caption still flagged after 3 attempts — accepting as-is.');
    }
    return t;
  };

  // Candidate A.
  const a = await guardedDraw();
  const sa = scorePost(a, ctx);
  let text = a;

  // News posts: draw an independent second caption and keep the cleaner one,
  // which smooths out the occasional gibberish token from the free model
  // (e.g. the "_performance" / nonsense-word glitches). If the second draw fails
  // (rate limit etc.), keep the first caption instead of failing the run.
  if (type === 'news') {
    try {
      const b = await guardedDraw();
      const sb = scorePost(b, ctx);
      if (sb > sa) text = b;
      console.log(`✨ Picked better of 2 generated captions (scores ${Math.max(sa, sb)}).`);
    } catch (err) {
      console.warn(`⚠️  Second caption draw skipped (${err.message?.slice(0, 80)}) — using first caption.`);
    }
  }

  // Threads hard cap is 500 chars; trim gently if exceeded.
  if (text.length > 490) {
    const cut = text.slice(0, 470);
    const lastSpace = cut.lastIndexOf(' ');
    text = cut.slice(0, lastSpace > 0 ? lastSpace : cut.length) + '…';
  }

  if (!text) throw new Error('LLM returned empty post');
  return text;
}