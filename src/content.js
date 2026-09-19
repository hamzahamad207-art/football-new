// Content generator — picks a topic (a fresh BBC Arabic headline for "news",
// otherwise a canned topic) and writes Khaleeji Arabic post text via an
// OpenAI-compatible chat-completions API.
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

// Free Arabic football headlines — BBC Arabic sport RSS, no API key needed.
const BBC_ARABIC_RSS = 'https://feeds.bbci.co.uk/arabic/sport/rss.xml';

// Live / recent / upcoming match data — ESPN's public scoreboard API (no key).
const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const ESPN_LEAGUES = [
  'eng.1', 'esp.1', 'ita.1', 'bund.1', 'fra.1', 'ksa.1',
  'uefa.champions', 'uefa.europa',
];

// Trending-headline sources — authentic football outlets, no API keys needed.
// ESPN exposes a news JSON endpoint; Sky/BBC/Google News are RSS feeds. All
// are fetched in parallel and the newest unique titles win.
const NEWS_FEEDS = {
  ESPN: { kind: 'json', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/news' },
  'Sky Sports': { kind: 'rss', url: 'https://www.skysports.com/rss/12040' },
  'BBC Sport': { kind: 'rss', url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
  'Google News': {
    kind: 'rss',
    url: 'https://news.google.com/rss/search?q=football&hl=en-GB&gl=GB&ceid=GB:en',
  },
  'BBC Arabic': { kind: 'rss', url: BBC_ARABIC_RSS },
};

// The Google News aggregator also surfaces non-soccer items ("American
// football", other sports). Filter its items to football vocabulary only.
const FOOTBALL_RE =
  /football|soccer|premier\s*league|champions\s*league|europa\s*league|la\s*liga|laliga|bundesliga|serie\s*a\s?|ligue\s*1|world\s*cup|derby|transfer|sign(?:ing|ed)|goal|match|league|cup|manager|striker|midfielder|defender|goalkeep|coach|ronaldo|messi|mbappe|haaland|salah|barcelona|real\s*madrid|man(?:chester|\.?\s?u|\.?\s?c|.?u|.?c|utd|city)|arsenal|liverpool|chelsea|bayern|psg|juventus|milan|inter|tottenham|newcastle|aston\s*villa|sevilla|atletico|napoli|dortmund/i;

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

/** Strip XML/CDATA/entities noise out of an RSS title. */
function cleanXmlTitle(raw) {
  return String(raw)
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize to a seconds or ms epoch timestamp, else -Infinity. */
function toEpoch(v) {
  if (!v) return -Infinity;
  const n = Number(v);
  return Number.isFinite(n) ? n : -Infinity;
}

/** Fetch + parse an RSS feed into [{ title, date }] (date=-Infinity if unset). */
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
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const t = titleRe.exec(m[1]);
    if (!t || !t[1]) continue;
    const title = cleanXmlTitle(t[1]);
    if (!title) continue;
    const d = dateRe.exec(m[1]);
    items.push({ title, date: d && d[1] ? Date.parse(d[1]) : -Infinity });
  }
  return items;
}

/** Fetch ESPN's soccer news JSON into [{ title, date }]. */
async function fetchEspnNews(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'TouchlineARBot/2.0' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`ESPN news HTTP ${res.status}`);
  const data = await res.json();
  return (data.articles || [])
    .map((a) => ({ title: cleanXmlTitle(a.headline || a.description || ''), date: toEpoch(a.published) }))
    .filter((a) => a.title);
}

/**
 * Fetch the most trending/latest football headlines from authentic outlets
 * (ESPN, Sky Sports, BBC Sport, BBC Arabic + the Google News aggregator) in
 * parallel. Dedupes by normalized title and returns the newest unique titles,
 * newest first. Returns [] on total failure — the caller then fails cleanly
 * instead of posting stale/guessed material.
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
    for (const it of items) {
      // Google News aggregates everything — only keep football-flavoured items.
      if (name === 'Google News' && !FOOTBALL_RE.test(it.title)) continue;
      const key = it.title
        .toLowerCase()
        .replace(/[^a-z0-9\u0600-\u06FF\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      all.push({ title: it.title, date: it.date, source: name });
    }
  }

  // Truly latest first.
  all.sort((a, b) => b.date - a.date);

  const top = all.slice(0, 12).map((it) => it.title);
  if (top.length) {
    console.log(
      `🌐 Trending headlines: ${top.length} newest unique items ` +
        `(sources: ${[...new Set(all.slice(0, 12).map((i) => i.source))].join(', ')})`
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
 * Turn a raw ESPN match + tag into the {topic, header, matchUp, summary, recap}
 * context used by all templates. `header` is a deterministic TouchlineX-style
 * line (LIVE/FT/NEXT) the model must copy verbatim — it can't invent a score
 * or a different match. `recap` carries the API recap sentence (real info,
 * optional flavor) the model may paraphrase but never exceed.
 */
function annotateMatch(m, tag) {
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

  return {
    topic: m.label,
    matchUp,
    header,
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
    return annotateMatch(m, pick.tag);
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
    return annotateMatch(hit, tag);
  } catch (err) {
    console.warn(`⚠️  Could not search matches for topic (${err.message}).`);
    return null;
  }
}

/**
 * Resolve the topic for this run.
 *   - A --topic / BOT_TOPIC override always wins.
 *   - "news" with no topic → current/ongoing match (live → latest result →
 *     next fixture) → else a fresh BBC Arabic headline. Never canned topics
 *     (that's what let the model invent "Copa del Rey final" style garbage) —
 *     if no fresh data at all, the run fails cleanly instead.
 * Returns { topic, header, summary }.
 */
export async function fetchNewsContext(type, opts = {}) {
  const override = (opts.topicOverride || '').trim();

  if (override) {
    // Try to attach the REAL live fixture when the user names a match —
    // accurate score + recap instead of the model guessing.
    const found = await findMatchForTopic(override);
    if (found) return found;
    console.log(`🎯 Topic override (no live fixture found): "${override}"`);
    return { topic: override, header: `🚨 ${override}`, recap: '', summary: '' };
  }

  // Real-time content whenever it's available — not just for "news".
  if (type === 'news' || type === 'stats' || type === 'analysis') {
    const live = await getLiveMatchContext();
    if (live) return live;
  }

  if (type === 'news') {
    const headlines = await fetchTrendingHeadlines();
    if (headlines.length) {
      const topic = pickRandom(headlines);
      console.log(`📰 Trending headline picked: ${topic}`);
      return { topic, header: `📰 ${topic}`, recap: '', summary: '' };
    }

    throw new Error(
      `No current match data from ESPN and no trending headline available right now. ` +
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

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });

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

/**
 * Domain guard for the generated caption. Two layers:
 *   1. Anchoring: if the caption starts with our own match header (FT/LIVE/
 *      NEXT/🚨/📰) it is definitively football — trust it.
 *   2. Vocabulary check — none of our football terms at all ⇒ flagged
 *      (catches the "Gen Z study habits", "military", etc. rambles).
 *   3. An LLM classifier as a second opinion.
 * Returns true (football) or false (off-topic → generation will be retried).
 */
async function isFootballOnly(text, header) {
  const anchored = header && /^(?:FT|LIVE|NEXT|🚨|📰)/.test(text);
  const hasVocab = anchored || containsFootballVocab(text);
  if (!hasVocab) {
    console.warn('⚽ Guard: no football vocabulary in caption — flagged.');
    return false;
  }
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

  let text = clean(
    await chatComplete({
      systemPrompt: tpl.systemPrompt,
      userPrompt: tpl.userPrompt(ctx),
      temperature: tpl.temperature ?? 0.8,
    })
  );

  // If the caption drifted off football, regenerate once before giving up on it.
  if (tpl.footballOnly !== false && !(await isFootballOnly(text, ctx?.header))) {
    console.warn('⚽ Guard: output drifted off football — regenerating once...');
    text = clean(
      await chatComplete({
        systemPrompt: tpl.systemPrompt,
        userPrompt: tpl.userPrompt(ctx),
        temperature: tpl.temperature ?? 0.8,
      })
    );
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