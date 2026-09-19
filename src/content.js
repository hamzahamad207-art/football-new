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
 * Resolve the topic for this run.
 *   - A --topic / BOT_TOPIC override always wins.
 *   - "news" tries a fresh BBC Arabic headline first.
 *   - Otherwise a random topic from FALLBACK_TOPICS.
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
    max_tokens: 400,
  };

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
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('LLM returned empty content');
  return text;
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