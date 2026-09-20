/**
 * Touchline Agent Bridge — calls the consolidated Python agent as a subprocess.
 *
 * Provides async wrappers for every action the Python agent supports:
 *   route, generate, generate_with_style, verify, research, style_analyze, score
 *
 * The Python agent reads JSON on stdin and writes JSON on stdout.
 * This bridge handles the subprocess communication.
 *
 * Falls back gracefully to the existing Node.js pipeline if Python isn't
 * available or the agent errors out.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AGENT_SCRIPT = path.join(__dirname, '..', 'agents', 'touchline_agent.py');
const AGENT_TIMEOUT = 30_000; // 30s — LLM calls can be slow

/**
 * Check if the Python agent is available.
 * @returns {boolean}
 */
export function isAgentAvailable() {
  return existsSync(AGENT_SCRIPT);
}

/**
 * Call the Python agent with a request object.
 * @param {object} request - Action + params
 * @param {number} [timeout] - Timeout in ms
 * @returns {Promise<object>} - Agent response
 */
async function callAgent(request, timeout = AGENT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify(request);
    let settled = false;

    // Try python3 first, fall back to python (Windows compatibility)
    const python = process.platform === 'win32' ? 'python' : 'python3';

    try {
      const child = execFile(python, [AGENT_SCRIPT], {
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
        env: {
          ...process.env,
          LLM_API_KEY: process.env.LLM_API_KEY || '',
          LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
          LLM_MODEL_STRONG: process.env.LLM_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free',
          LLM_MODEL_CHEAP: process.env.LLM_MODEL_CHEAP || 'google/gemma-3-1b-it:free',
        },
      }, (error, stdout, stderr) => {
        if (settled) return;
        settled = true;

        if (error) {
          const msg = String(error?.message || error || 'unknown error');
          console.error(`[Agent] Python agent error: ${msg}`);
          if (stderr) console.error(`[Agent] stderr: ${String(stderr).slice(0, 500)}`);
          // Resolve with error object instead of rejecting — prevents process crash
          resolve({ error: msg });
          return;
        }

        try {
          const result = JSON.parse(String(stdout || '').trim());
          resolve(result);
        } catch (parseErr) {
          console.error(`[Agent] Failed to parse agent output: ${String(stdout).slice(0, 200)}`);
          resolve({ error: `parse error: ${parseErr.message}` });
        }
      });

      // Handle stdin errors (e.g. process already exited)
      child.stdin.on('error', () => {
        if (!settled) {
          settled = true;
          resolve({ error: 'stdin error' });
        }
      });

      // Write the request to stdin
      child.stdin.write(input);
      child.stdin.end();
    } catch (e) {
      // execFile itself threw (e.g. python not found)
      if (!settled) {
        settled = true;
        resolve({ error: String(e?.message || e) });
      }
    }
  });
}

/**
 * Smart model routing — decide which model to use for a given task.
 *
 * @param {string} contentType - news, stats, analysis, meme, etc.
 * @param {string} [topic] - Optional topic override
 * @param {object} [context] - Article context if available
 * @returns {Promise<{model: string, reason: string}>}
 */
export async function routeModel(contentType, topic = '', context = null) {
  const result = await callAgent({
    action: 'route',
    type: contentType,
    topic,
    context,
  });
  if (result.error) return { model: 'strong', reason: 'Agent unavailable — using strong model' };
  return result;
}

/**
 * Generate a caption using two-pass generation with quality checks.
 *
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @param {number} [temperature=0.7] - Sampling temperature
 * @param {string} [typeName='news'] - Content type for scoring
 * @returns {Promise<{caption: string, draw: string, skipped_b: boolean, checks_passed: boolean}>}
 */
export async function generateCaption(systemPrompt, userPrompt, temperature = 0.7, typeName = 'news') {
  return callAgent({
    action: 'generate',
    system_prompt: systemPrompt,
    user_prompt: userPrompt,
    temperature,
    type: typeName,
  });
}

/**
 * Generate a caption with style profile injection for consistent voice.
 *
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @param {object|null} styleProfile - Style profile from analyzeStyle()
 * @param {number} [temperature=0.7]
 * @returns {Promise<{caption: string}>}
 */
export async function generateWithStyle(systemPrompt, userPrompt, styleProfile = null, temperature = 0.7) {
  return callAgent({
    action: 'generate_with_style',
    system_prompt: systemPrompt,
    user_prompt: userPrompt,
    style_profile: styleProfile,
    temperature,
  });
}

/**
 * Verify a caption against source data for fact-grounding.
 *
 * @param {string} caption - The generated caption
 * @param {object} context - Source context (header, recap, facts, topic)
 * @returns {Promise<{passed: boolean, issues: string[], score: number}>}
 */
export async function verifyCaption(caption, context) {
  const result = await callAgent({
    action: 'verify',
    caption,
    context,
  });
  if (result.error) throw new Error(result.error);
  return result;
}

/**
 * Enrich context with web research (scrape article body, generate talking points).
 *
 * @param {string} contentType - Content type
 * @param {string} [topic] - Topic
 * @param {object} [articleData] - Existing article data
 * @returns {Promise<object>} - Enriched context
 */
export async function researchContext(contentType, topic = '', articleData = null) {
  const result = await callAgent({
    action: 'research',
    type: contentType,
    topic,
    article_data: articleData,
  });
  if (result.error) throw new Error(result.error);
  return result;
}

/**
 * Analyze a set of existing posts to extract a style profile.
 *
 * @param {string[]} posts - Array of post texts
 * @returns {Promise<object>} - Style profile
 */
export async function analyzeStyle(posts) {
  return callAgent({
    action: 'style_analyze',
    posts,
  });
}

/**
 * Score a caption (quick quality check without full verification).
 *
 * @param {string} caption - The caption to score
 * @param {string} [typeName='news'] - Content type
 * @returns {Promise<{score: number}>}
 */
export async function scoreCaption(caption, typeName = 'news') {
  return callAgent({
    action: 'score',
    caption,
    type: typeName,
  });
}

/**
 * Health check — verify the agent is running and configured.
 *
 * @returns {Promise<{status: string, model_strong: string, model_cheap: string}>}
 */
export async function agentHealth() {
  const result = await callAgent({ action: 'health' });
  if (result.error) throw new Error(result.error);
  return result;
}

export default {
  isAgentAvailable,
  routeModel,
  generateCaption,
  generateWithStyle,
  verifyCaption,
  researchContext,
  analyzeStyle,
  scoreCaption,
  agentHealth,
};
