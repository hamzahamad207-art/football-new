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
const DEFAULT_MODEL = 'glm-4.5-flash';

// Free Arabic football headlines — BBC Arabic sport RSS, no API key needed.
const BBC_ARABIC_RSS = 'https://feeds.bbci.co.uk/arabic/sport/rss.xml';

// Live / recent / upcoming match data — ESPN's public scoreboard API (no key).
const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const ESPN_LEAGUES = [
  'eng.1', 'esp.1', 'ita.1', 'bund.1', 'fra.1', 'ksa.1',
  'uefa.champions', 'uefa.europa',
];

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

/**
 * Fetch the latest Arabic football headlines from BBC Arabic's RSS feed so
 * "news" posts are actually fresh. Returns [] on any error (offline, changed
 * feed format, etc.) — the caller then falls back to canned topics.
 */
async function fetchFreshHeadlines() {
  try {
    const res = await fetch(BBC_ARABIC_RSS, {
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
        'User-Agent': 'TouchlineARBot/2.0 (Threads football page)',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);

    const xml = await res.text();
    const titles = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    const titleRe = /<title>([\s\S]*?)<\/title>/i;
    let m;
    while ((m = itemRe.exec(xml)) !== null && titles.length < 12) {
      const t = titleRe.exec(m[1]);
      if (t && t[1]) {
        const clean = t[1]
          .replace(/<!\[CDATA\[|\]\]>/g, '')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (clean) titles.push(clean);
      }
    }
    return titles;
  } catch (err) {
    console.warn(`⚠️  Could not fetch fresh headlines (${err.message}). Using a canned topic.`);
    return [];
  }
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
 * Build a {topic, summary} context for the current/ongoing match so "news"
 * posts are about real games happening right now.
 */
async function getLiveMatchContext() {
  try {
    const matches = await fetchCurrentMatches();
    const pick = pickBestMatch(matches);
    if (!pick) return null;
    const m = pick.match;
    if (pick.tag === 'live') {
      console.log(`🔴 Live match: ${m.label} ${m.score} (${m.detail})`);
      return {
        topic: m.label,
        summary: `المباراة الآن بين ${m.label} والنتيجة ${m.score} في الدقيقة ${m.detail}.`,
      };
    }
    if (pick.tag === 'recent') {
      console.log(`📰 Latest result: ${m.label} ${m.score}`);
      return {
        topic: m.label,
        summary: `انتهت مباراة ${m.label} ${m.score ? `بنتيجة ${m.score}` : ''}. ${m.summary}`,
      };
    }
    console.log(`📅 Next match: ${m.label}`);
    return {
      topic: m.label,
      summary: `مباراة قادمة: ${m.label}. ${m.summary}`,
    };
  } catch (err) {
    console.warn(`⚠️  Could not fetch live matches (${err.message}).`);
    return null;
  }
}

/**
 * Resolve the topic for this run.
 *   - A --topic / BOT_TOPIC override always wins.
 *   - "news" with no topic → current/ongoing match (live → latest result →
 *     next fixture) → else a fresh BBC Arabic headline → else canned topics.
 * Returns { topic, summary }.
 */
export async function fetchNewsContext(type, opts = {}) {
  const tpl = TEMPLATES[type];
  const override = (opts.topicOverride || '').trim();

  if (override) {
    console.log(`🎯 Topic override: "${override}"`);
    return { topic: override, summary: '' };
  }

  if (type === 'news') {
    const live = await getLiveMatchContext();
    if (live) return live;

    const headlines = await fetchFreshHeadlines();
    if (headlines.length) {
      const topic = pickRandom(headlines);
      console.log(`📰 Fresh headline (BBC Arabic): ${topic}`);
      return { topic, summary: '' };
    }
  }

  const topic = pickRandom(FALLBACK_TOPICS[type]);
  console.log(`📋 Random canned topic: ${topic}`);
  return { topic, summary: '' };
}

/**
 * Call an OpenAI-compatible chat-completions endpoint.
 * Defaults to Z.ai's public GLM API; can be repointed to OpenAI / Groq /
 * OpenRouter via env vars.
 */
async function chatComplete({ systemPrompt, userPrompt }) {
  const { apiKey, baseUrl, model } = llmConfig();
  const url = `${baseUrl}/chat/completions`;

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.8,
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

/**
 * Generate the Arabic post text via the LLM, using the template's system +
 * user prompts. Returns a string (cleaned of markdown fences).
 */
export async function generatePostText(type, ctx) {
  const tpl = TEMPLATES[type];
  if (!tpl) throw new Error(`Unknown content type: ${type}`);

  console.log(`✍️  Generating ${type} post in Khaleeji Arabic...`);

  let text = await chatComplete({
    systemPrompt: tpl.systemPrompt,
    userPrompt: tpl.userPrompt(ctx),
  });

  // Cleanup markdown fences / wrapping quotes
  text = text
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/```$/i, '')
    .replace(/^["'“”]|["'“”]$/g, '')
    .trim();

  // Threads hard cap is 500 chars; trim gently if exceeded.
  if (text.length > 490) {
    const cut = text.slice(0, 470);
    const lastSpace = cut.lastIndexOf(' ');
    text = cut.slice(0, lastSpace > 0 ? lastSpace : cut.length) + '…';
  }

  if (!text) throw new Error('LLM returned empty post');
  return text;
}