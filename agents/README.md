# Touchline Agent — Consolidated AI Assistant

A single Python tool that combines patterns from 5 awesome-ai-apps projects into
one unified agent for The Touchline AR bot.

## What It Does

| # | Pattern | Source Project | What It Adds |
|---|---------|---------------|--------------|
| 1 | **Smart Model Routing** | [RouteLLM](https://github.com/Arindam200/awesome-ai-apps/tree/main/simple_ai_agents/llm_router) | Routes simple types (meme/quote/fact) to fast cheap model, complex types (news/analysis) to strong model |
| 2 | **Two-Pass Generation** | [Human-in-the-Loop](https://github.com/Arindam200/awesome-ai-apps/tree/main/simple_ai_agents/human_in_the_loop_agent) | Generates 2 captions, scores both, picks the better one. Skips Draw B when Draw A passes all checks cleanly |
| 3 | **Web Research** | [Newsletter Generator](https://github.com/Arindam200/awesome-ai-apps/tree/main/simple_ai_agents/newsletter_agent) | Scrapes article body text for richer context, generates talking points for canned types |
| 4 | **Fact Verification** | [Brand Reputation Monitor](https://github.com/Arindam200/awesome-ai-apps/tree/main/memory_agents/brand_reputation_monitor) | Verifies captions against source data — catches invented club names, ungrounded players, Latin leaks |
| 5 | **Style Analysis** | [Blog Writing Agent](https://github.com/Arindam200/awesome-ai-apps/tree/main/memory_agents/blog_writing_agent) | Analyzes your existing posts to extract a style profile, injects it into future prompts for consistent voice |

## How It Works

The Node.js bot calls this Python agent as a subprocess. Communication is
JSON-over-stdin/stdout — no files, no network, no GUI.

```
Node.js (index.js)
  │
  ├── agent.js (bridge module)
  │     │
  │     └── subprocess: python agents/touchline_agent.py
  │           │
  │           ├── route     → which model to use
  │           ├── generate  → two-pass caption with scoring
  │           ├── verify    → fact-check against source data
  │           ├── research  → scrape article body for context
  │           └── style_*   → analyze/apply writing style
  │
  └── existing pipeline (content.js, images.js, overlay.js, threads.js)
```

## Integration Points

The agent hooks into the existing pipeline at 3 places:

1. **Before generation** — Research enrichment + model routing
2. **After generation** — Fact verification (news type only)
3. **Optional** — Style profile injection for consistent voice

The existing Node.js guards and scoring remain active — the agent adds a
second verification layer, not a replacement.

## Usage

### From Node.js (automatic)

The agent is called automatically when available. If Python isn't installed
or the agent errors out, the bot falls back to the existing Node.js pipeline.

### From command line (manual testing)

```bash
# Health check
echo '{"action":"health"}' | python agents/touchline_agent.py

# Route a content type
echo '{"action":"route","type":"meme","topic":"messi"}' | python agents/touchline_agent.py

# Generate a caption
echo '{"action":"generate","system_prompt":"...","user_prompt":"...","type":"meme"}' | python agents/touchline_agent.py

# Verify a caption
echo '{"action":"verify","caption":"...","context":{"header":"FT: ...","topic":"..."}}' | python agents/touchline_agent.py

# Analyze writing style from existing posts
echo '{"action":"style_analyze","posts":["post1","post2","post3"]}' | python agents/touchline_agent.py
```

### Health check from Node.js

```javascript
import { agentHealth } from './src/agent.js';
const health = await agentHealth();
console.log(health); // { status: "ok", model_strong: "...", model_cheap: "..." }
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_API_KEY` | ✅ | — | OpenRouter API key |
| `LLM_BASE_URL` | ❌ | `https://openrouter.ai/api/v1` | API endpoint |
| `LLM_MODEL` | ❌ | `nvidia/nemotron-3-ultra-550b-a55b:free` | Strong model for complex tasks |
| `LLM_MODEL_CHEAP` | ❌ | `google/gemma-3-1b-it:free` | Cheap model for simple tasks |

## Requirements

- Python 3.10+
- No external packages (uses only stdlib)

## Files

| File | Purpose |
|------|---------|
| `touchline_agent.py` | The consolidated agent (all 5 patterns) |
| `run_agent.py` | Wrapper for subprocess calls |
| `requirements.txt` | Dependencies (none — stdlib only) |
| `README.md` | This file |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Touchline Agent: not available` | Ensure Python 3.10+ is installed and `python` is on PATH |
| `LLM_API_KEY env var not set` | Set the env var or GitHub Secret |
| `Agent unavailable` | Check Python version, check LLM_API_KEY is valid |
| Verification shows issues | Review the caption manually — the agent catches common hallucinations |
