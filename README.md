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
account — short, punchy, ends with a question to drive engagement.

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
# 1. Copy env template and fill in your Z.ai key
cp .env.example .env
# Edit .env: set LLM_API_KEY=<your Z.ai key from https://z.ai>

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
| `--help, -h`      | Show usage                                      |

You can also set the topic via the `BOT_TOPIC` env var (used by the GitHub Actions workflow).

---

## Getting your Z.ai API key

The bot uses the Z.ai public GLM-4 API (OpenAI-compatible, free tier) to generate Arabic text.

1. Go to https://z.ai/ and sign in (Google or email)
2. Open **API Keys** in the dashboard
3. Click **Create new key**
4. Copy the key — it'll look like `xxxxxxxx.xxxxxxxx.xxxxxxxx`
5. Save this as a GitHub Secret named `LLM_API_KEY` (see deploy instructions below)

The default model is `glm-4.5-flash` (free tier, good Arabic). To use a better
model, override `LLM_MODEL` (e.g. `glm-4.7-flash` free, or `glm-4.6`, `glm-5.3` paid).

### Using OpenAI / Groq / OpenRouter instead

The bot calls any OpenAI-compatible endpoint. Just override `LLM_BASE_URL` and
`LLM_MODEL`:

| Provider  | LLM_BASE_URL                          | LLM_MODEL                       |
| --------- | ------------------------------------- | ------------------------------- |
| Z.ai (default) | https://api.z.ai/api/paas/v4      | glm-4.5-flash                  |
| OpenAI    | https://api.openai.com/v1             | gpt-4o-mini                     |
| Groq      | https://api.groq.com/openai/v1        | llama-3.3-70b-versatile         |
| OpenRouter | https://openrouter.ai/api/v1        | meta-llama/llama-3.3-70b-instruct |

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
3. Silently prompts for your Z.ai API key (input hidden)
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
   - `LLM_API_KEY` — your Z.ai API key (required)
   - `THREADS_ACCESS_TOKEN` — your Threads long-lived token
   - `THREADS_USER_ID` — your numeric Threads user id
   - (Optional) `LLM_BASE_URL` — override if using OpenAI/Groq/OpenRouter
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
| `LLM API 401: token expired or incorrect` | Bad Z.ai API key | Regenerate at https://z.ai → API Keys |
| `LLM API 404: model not found` | Wrong model name | Set `LLM_MODEL=glm-4.5-flash` (or `glm-4.7-flash`, `glm-4.6`) in Settings → Secrets |
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
