# The Touchline AR — Threads Soccer Bot

A bot that posts Khaleeji Arabic soccer content to [Threads](https://threads.net),
in the style of [@TouchlineX on X](https://x.com/TouchlineX).

It generates Arabic post text via the Z.ai public GLM-4 API (OpenAI-compatible,
free), pulls a matching CC-licensed photo from Openverse (no API key needed),
and publishes via the Threads Graph API. Runs on GitHub Actions with a **manual
"Run workflow" button** — no server required.

---

## What it posts

Five content styles, picked per run:

| Type        | What it does                                                           |
| ----------- | --------------------------------------------------------------------- |
| `news`      | Writes a Khaleeji Arabic post about a soccer headline/topic you specify — or the latest BBC Arabic headline when blank |
| `stats`     | Highlights a player/team stat (goals, records, comparisons)            |
| `analysis`  | Tactical breakdown of a recent match or strategy                     |
| `meme`      | Short Khaleeji soccer joke                                           |
| `throwback` | Nostalgic post about an iconic match / goal / player                 |
| `fact`      | Fun, little-known football fact, Khaleeji tone                          |
| `quote`     | Famous player/coach quote + your Khaleeji take                           |

All text is in **Khaleeji (Gulf) Arabic** with the tone of a casual fan
account — short, punchy, opening with a strong headline and closing with an
engaging line (a question only when it makes the post more engaging).

The bot **never repeats a story** — a history in `out/news-seen.json` blocks
the same team/player headline from being picked twice. Images are **real CC
photos only** (never AI), with **HD sources preferred**, and TV-graphic article
images (e.g. a "GOSSIP" banner) are avoided for trending news in favor of clean
stock photos.

---

## Project layout

```
touchline-arabic-bot/
├── src/
│   ├── index.js        # CLI entry — orchestrates everything
│   ├── templates.js    # Content type templates + system prompts
│   ├── content.js      # LLM call (fetch to OpenAI-compatible endpoint)
│   ├── images.js       # Image search via Openverse (free, no key)
│   └── threads.js      # Threads Graph API client (create + publish)
├── .github/workflows/
│   └── post.yml        # GitHub Actions — manual "Run workflow"
├── .env.example
├── deploy.sh           # One-shot deployer (uses `gh` CLI, OAuth)
├── package.json
└── README.md
```

---

## Local dev — try it before posting

```bash
# 1. Copy env template and fill in your OpenRouter key
cp .env.example .env
# Edit .env: set LLM_API_KEY=<your key from https://openrouter.ai/keys>

# 2. Load env vars
export $(grep -v '^#' .env | xargs)

# 3. Dry run (preview content + image — does NOT post)
node src/index.js --dry-run
node src/index.js -t meme --dry-run
node src/index.js -t news --topic "Barcelona vs Sevilla" --dry-run

# 4. Live post (also needs THREADS_ACCESS_TOKEN + THREADS_USER_ID in .env)
node src/index.js -t throwback --post
```

CLI flags:

| Flag              | What it does                                    |
| ----------------- | ----------------------------------------------- |
| `--type, -t <x>`  | Content type: `news`/`stats`/`analysis`/`meme`/`throwback`/`fact`/`quote`/`random` |
| `--topic, -m <text>` | Focus on a specific match / player / topic (e.g. `"Barcelona vs Sevilla"` or `"محمد صلاح"`) |
| `--post`          | Actually publish to Threads (default off)      |
| `--dry-run`       | Print only, don't post (default)                |
| `--republish`     | Re-publish the last saved post (exact caption + image; no new generation) |
| `--help, -h`      | Show usage                                      |

You can also set the topic via the `BOT_TOPIC` env var (used by the GitHub Actions workflow).

### Re-publish the last post (one click, no new generation)

Every run that composes + hosts an image also saves the post to
`out/last-post.json` (caption + image URL). To post **that exact post** again:

1. Go to **Actions → "The Touchline AR — Post to Threads" → Run workflow**
2. Check **"Re-publish the last saved post"** (leave content type / topic as-is —
   they're ignored)
3. **Posting still needs approval**: leave `dry_run` checked to preview the
   stored post, or uncheck it to publish it for real
4. Run — the bot posts the saved caption + image exactly, without generating
   anything new

---

## Getting your OpenRouter API key

The bot generates Arabic text via **OpenRouter** (OpenAI-compatible), using a
free frontier-tier model — NVIDIA Nemotron 3 Ultra — at **no cost**.

1. Go to https://openrouter.ai/keys and create an account (Google/email)
2. Open **Keys** → **Create Key** (no credits needed — the model is free)
3. Copy the key — it starts with `sk-or-v1-…`
4. Save it as a GitHub Secret named `LLM_API_KEY` (see deploy instructions below)

The default model is `nvidia/nemotron-3-ultra-550b-a55b:free` (free tier,
frontier-class). To switch models or providers, override `LLM_MODEL` and
`LLM_BASE_URL`:

| Provider  | LLM_BASE_URL                          | LLM_MODEL                       |
| --------- | ------------------------------------- | ------------------------------- |
| OpenRouter (default) | https://openrouter.ai/api/v1    | nvidia/nemotron-3-ultra-550b-a55b:free |
| Z.ai      | https://api.z.ai/api/paas/v4          | glm-4.7-flash                |
| OpenAI    | https://api.openai.com/v1             | gpt-4o-mini                     |
| Groq      | https://api.groq.com/openai/v1        | llama-3.3-70b-versatile         |

---

## Getting Threads API credentials

Threads uses Meta's Graph API. To get a token:

1. Go to https://developers.facebook.com/apps/ and click **Create App**.
2. Pick **Business → Threads** as the product.
3. Add the **Threads API** product to your app.
4. Generate a **long-lived access token** (Steps:
   [Threads API Quickstart](https://developers.facebook.com/docs/threads/getting-started/quickstart)).
5. Get your **Threads user id** (numeric — shown in the same console after you
   link your Threads account).
6. Save these two values as **GitHub Secrets** (below).

---

## Setting up GitHub Actions (free, no server)

### Option A — Use `deploy.sh` (recommended)

A one-shot script that creates the repo, pushes code, sets your secrets
(LLM_API_KEY + THREADS_ACCESS_TOKEN + THREADS_USER_ID), and triggers the first
dry-run. Uses `gh` CLI (OAuth — no token pasting anywhere).

```bash
# 1. Install GitHub CLI if you don't have it:
#    https://cli.github.com/
#
# 2. Authenticate (one-time):
gh auth login

# 3. From the bot folder, run:
./deploy.sh
```

The script:
1. Verifies `gh` is installed and you're logged in
2. Asks you for a repo name + visibility
3. Silently prompts for your OpenRouter API key (input hidden)
4. Silently prompts for your Threads token + user id (input hidden)
5. Creates the repo, commits, pushes
6. Sets `LLM_API_KEY`, `LLM_MODEL`, `THREADS_ACCESS_TOKEN`, `THREADS_USER_ID` as GitHub Secrets
7. Triggers the first dry-run workflow

> If the repo name already exists on your account, the script now asks whether
> to **push to that existing repo** (it force-replaces its `main` branch).

### Option B — Manual

1. Create a new GitHub repository (private recommended).
2. Push this folder to it:
   ```bash
   cd touchline-arabic-bot
   git init && git add -A && git commit -m "init bot"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
3. Go to the repo on GitHub → **Settings → Secrets and variables → Actions →
   New repository secret**, add:
   - `LLM_API_KEY` — your OpenRouter API key (required)
   - `THREADS_ACCESS_TOKEN` — your Threads long-lived token
   - `THREADS_USER_ID` — your numeric Threads user id
   - (Optional) `LLM_BASE_URL` — override if using Z.ai/OpenAI/Groq/Gemini instead
   - (Optional) `LLM_MODEL` — override model name
4. Go to **Actions tab → "The Touchline AR — Post to Threads" → Run workflow**.
5. Choose content type (`random` by default), optional topic, and `dry_run` (off = real post).
6. Watch the run finish in ~1-2 minutes.

### Schedule automatic posts (optional)

If you later want it to auto-post, add a `schedule` trigger to
`.github/workflows/post.yml`:

```yaml
on:
  workflow_dispatch: {}
  schedule:
    - cron: '0 */6 * * *'   # every 6 hours
```

(GitHub Actions scheduled jobs may be delayed during peak load. For real-time
posting, use a VPS + cron instead.)

---

## How content generation works

1. **Topic resolution** — if `--topic` is set (or `BOT_TOPIC` env var), uses it.
   For `news` with no topic, the bot grabs a **fresh BBC Arabic headline**
   (free RSS feed). Otherwise it picks a random canned topic for the type.
2. **LLM call** — `POST {LLM_BASE_URL}/chat/completions` with the system + user
   prompts from `src/templates.js`. The system prompt enforces Khaleeji Arabic
   + Threads-style tone. Response is capped at ~490 chars to fit Threads limit.
3. **Image fetch** — calls `https://api.openverse.org/v1/images/?q=soccer...`
   and picks a CC-licensed Flickr/Wikimedia photo. URL is publicly reachable
   so the Threads API can download it.
4. **Threads post** — calls Threads Graph API:
   - `POST /v1.0/{user_id}/threads` to create a media container (`media_type=IMAGE`,
     `image_url=...`, `text=...`).
   - `POST /v1.0/{container_id}/publish` to push it live.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| `LLM_API_KEY env var is not set` | Secret not set in GitHub | Add it in Settings → Secrets → Actions |
| `LLM API 401: token expired or incorrect` | Bad OpenRouter key | Regenerate at https://openrouter.ai/keys |
| `LLM API 404: model not found` | Wrong model name | Set `LLM_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free` in Settings → Secrets |
| `Threads createMediaContainer failed: 401` | Bad/expired Threads token | Regenerate at developers.facebook.com |
| `Threads createMediaContainer failed: 400` with `image_url` error | URL not reachable or wrong format | Try re-running; Openverse URLs are JPEG/PNG which Threads accepts |
| Openverse returns empty results | API rate-limited (3000/day per IP) | Wait a few minutes and retry, or skip image with `--type` that doesn't need photos |
| LLM output is English not Arabic | Prompt not honored | Verify `TEMPLATES[type].systemPrompt` exists and starts with Arabic instructions |

---

## Customizing

- **Change tone** — edit `TEMPLATES.<type>.systemPrompt` in `src/templates.js`.
- **Add content type** — add a new key to `TEMPLATES` and to the `CONTENT_TYPES` array.
- **Different leagues** — edit the `LEAGUES` array in `src/templates.js`.
- **More fallback topics** — edit `FALLBACK_TOPICS` in `src/templates.js`.
- **Post frequency** — change the `cron` in `.github/workflows/post.yml` (see above).
- **Different LLM provider** — set `LLM_BASE_URL` + `LLM_MODEL` secrets (see table above).
- **Better images** — swap the Openverse query in `src/images.js` for a more specific soccer term.

---

## Security notes

- **NEVER commit** `LLM_API_KEY`, `THREADS_ACCESS_TOKEN`, `THREADS_USER_ID`, or any
  API key to git. The included `.gitignore` excludes `.env` and `.tmp-*` files.
- This repo uses a `.env.example` template — fill in real values locally or in
  GitHub Secrets only.
- If you accidentally paste a secret into a chat, commit, or issue,
  **revoke it immediately** at the source dashboard and generate a new one.
