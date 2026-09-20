# AGENTS.md — The Touchline AR Bot (permanent knowledge)

Read this file every session before touching the code. It is stable, long-lived
knowledge. For the current state of the repo (last commit, what was tested,
open issues), read **HANDOFF.md**.

---

## 1. Project Overview

- **What it is**: A bot that posts **Khaleeji (Gulf) Arabic football content** to
  the user's **Threads** page, in the style of the X account
  [@TouchlineX](https://x.com/TouchlineX) — short, punchy posts with a strong
  header line, hype text, and an engaging closing line (a question only when it
  adds engagement).
- **Goal**: A human-quality Arabic football page that runs automatically, with
  zero invented facts, no AI images, and no English/Latin anywhere.
- **Brand**: "The Touchline AR." The bot is described as
  `touchline-arabic-bot` in `package.json`.
- **Repo**: `hamzahamad207-art/football-new` (public). The code lives in the
  `football-new-main/football-new-main/` subfolder of the working directory.
- **How it runs**: Almost always via **GitHub Actions** — the user clicks
  "Run workflow" on the GitHub repo (manual `workflow_dispatch`). It can also
  run locally with `node`, but the LLM key / Threads token are GitHub Secrets,
  so in practice runs happen in CI.
- **Dry-run by default**: Manual runs default to `dry_run=true` (preview only).
  Real publishing only happens when the user explicitly unchecks dry_run.

## 2. Pipeline, start to finish

```
topic/article data  →  LLM writes Arabic caption  →  pick real photo
→  stamp Arabic headline onto photo (overlay)  →  push composed image to repo out/
→  post to Threads via raw.githubusercontent.com URL
```

Step-by-step (each step's file):

1. **Topic / context resolution** — `src/index.js` calls
   `fetchNewsContext(type, { topicOverride })` in `src/content.js`. For `news`,
   it prefers the current/just-finished live match from ESPN's public API,
   then a trending headline from BBC Sport / Sky Sports / Google News RSS feeds
   (with the article's own summary + real photos). For canned types
   (stats/analysis/meme/throwback/fact/quote) it falls back to a random
   `FALLBACK_TOPICS` entry.
2. **LLM caption** — `generatePostText(type, ctx)` in `src/content.js` calls
   the OpenAI-compatible chat-completions endpoint (`chatComplete`). System +
   user prompts come from `src/templates.js`. Post text is cleaned, guarded,
   and (for `news`) twice-drawn with the better caption kept.
3. **Image picking** — `pickImageForContent(type, ctx)` in `src/images.js`.
   Article photos (og:image / JSON-LD) first, then CC stock photos from the
   Openverse API. Every candidate is validated as a fetchable image file, and
   URLs containing kid/children/youth are rejected.
4. **Arabic overlay** — `applyArabicOverlay(imageUrl, text)` in `src/overlay.js`
   downloads the real photo, renders the post's Arabic first line onto it with
   the Tajawal font (SVG + sharp/librsvg), producing a new JPEG.
5. **Host the composed image** — `pushComposedImage(file)` in `src/overlay.js`
   commits the JPEG into the repo's `out/` folder and pushes it to GitHub main,
   then returns a `https://raw.githubusercontent.com/{owner}/{repo}/main/out/tl-<ts>.jpg`
   URL (Threads' API requires a **publicly reachable** `image_url`).
6. **Post to Threads** — `postToThreads({ text, imageUrl })` in
   `src/threads.js`: create media container → publish. Dry-run skips this.

Guardrail: if `--post` is set but no image was found, the run **aborts**
(`throw new Error('No valid image found — post aborted...')`) in `src/index.js`
— TouchlineX-style posts must ship with a photo.

## 3. Content types (7, plus `random`)

Defined in `CONTENT_TYPES` in `src/templates.js`:

| type | Arabic label | Purpose | Special behavior |
|---|---|---|---|
| `news` | أخبار | Latest match / trending headline | Grabs live ESPN match first, else trending RSS headline. Draws 2 captions, keeps the better-scored one. Header is a verbatim FT:/LIVE:/NEXT: line OR a short Arabic headline. |
| `stats` | إحصائيات | A stat/record | Canned topic; optional recap from context. Starts with the number. `footballOnly` guard applies. |
| `analysis` | تحليل | Tactical breakdown | Canned topic; optional recap. |
| `meme` | سخرية | Short Khaleeji joke | No fresh news needed (`newsQuery: () => null`). |
| `throwback` | ذكريات | Nostalgic moment | Canned topic, nostalgic tone, may end with "تذكرونه؟" |
| `fact` | حقائق | Fun true fact | No fresh news needed. |
| `quote` | اقتباسات | Famous player/coach quote | No fresh news needed; must be a real, attributable quote. |
| `random` | — | Picks a random one of the 7 | Only valid via CLI / workflow choice; resolved in `src/index.js` via `pickRandom`. |

**Important one-liner**: `news` is the only type that uses article data for
fact-grounding; canned types skip the transliteration-grounding guard (see
Lessons Learned).

## 4. Tech stack

- **Runtime**: Node.js ≥ 18 (local); **Node 24** on the GitHub Actions runner
  (`actions/setup-node@v7`). ESM (`"type": "module"`).
- **Dependencies**: `sharp` `^0.33.4` (image compositing / SVG rendering). No
  other runtime deps; LLM, RSS, ESPN, Openverse, Threads are all hit with plain
  `fetch`.
- **LLM**: OpenRouter (OpenAI-compatible,
  `https://openrouter.ai/api/v1/chat/completions`). Default model in code:
  `nvidia/nemotron-3-ultra-550b-a55b:free` (free frontier-tier Nemotron 3 Ultra)
  — but the GitHub `LLM_MODEL` / `LLM_BASE_URL` secrets are what's actually
  used. OpenRouter's free tier **rate-limits** (HTTP 429 / "provider returned
  error" when a provider is busy), so every LLM call has 5 attempts with
  growing backoff `[2.5s, 5s, 10s, 20s]` and all caption calls are spaced
  700ms apart.
  - `thinking` is disabled only for Z.ai/BigModel endpoints via
    `body.thinking = { type: 'disabled' }` (GLM-4.5+ models otherwise burn the
    token budget on `reasoning_content` and return empty `content`).
  - OpenRouter attribution headers (`HTTP-Referer`, `X-Title`) are sent so the
    app shows on OpenRouter dashboards.
  - Free-model daily quota: ~50 requests/day per model without credits;
    adding as little as $10 of credits raises it to 1000/day (so double-draw
    + regens can't starve on busy days).
- **Image sources**: article photos (og:image/JSON-LD from the article page),
  then Openverse (`https://api.openverse.org/v1/images/`) which serves
  CC-licensed Flickr/Wikimedia photos. **Never AI-generated images.**
- **Threads API**: Meta Graph API `https://graph.threads.net/v1.0` — media
  container (`POST /{user_id}/threads`) then publish (`POST /{container_id}/publish`).
- **Fonts**: Tajawal (Black/ExtraBold/Bold) from google/fonts raw URLs:
  - `https://raw.githubusercontent.com/google/fonts/main/ofl/tajawal/Tajawal-Black.ttf`
  - `/Tajawal-ExtraBold.ttf`, `/Tajawal-Bold.ttf`
  - Downloaded once per process to `os.tmpdir()/touchline-tajawal-black.ttf`;
    the workflow also `fc-cache`s it for the runner.

## 5. File map

Repo root: `football-new-main/football-new-main/`

| File | What it does | Key functions |
|---|---|---|
| `src/index.js` | CLI orchestrator; arg parsing, main flow, abort-without-image | `parseArgs`, `printHelp`, `main` |
| `src/content.js` | Context resolution (ESPN/RSS/trending), LLM call, caption guards, caption scoring | `fetchNewsContext`, `chatComplete`, `generatePostText`, `isFootballOnly`, `findUngroundedName`, `findUngroundedTransliteration`, `findUngroundedClasico`, `normalizeNames`, `buildRegenNudge`, `arabicStems`, `scorePost`, `unknownTokenCount`, `containsFootballVocab`, `fetchTrendingHeadlines`, `fetchCurrentMatches`, `annotateMatch`, `enrichArticle`, `fetchMatchArticle`, `scoreHeaderFromTitle`, `resultArabic`, `fetchMatchFacts`, `normText`, `arSkel`, `enSkel`, `lev` (Levenshtein) |
| `src/images.js` | Pick a real, fetchable photo; article-first; stock fallback; kid-image filter | `pickImageForContent`, `searchImage`, `isValidImageUrl`, `isLikelyKidImage`, `isBlocked`, `buildImageQuery`, `toEnglishKeywords`, `shuffle`, `flickrId` |
| `src/overlay.js` | Arabic text overlay (Tajawal font via SVG + sharp) + repo hosting | `applyArabicOverlay`, `prepOverlayText`, `pushComposedImage`, `ensureArabicFont`, `wrapLines`, `escapeXml` |
| `src/templates.js` | Content templates (system/user prompts), fallback topics, leagues | `TEMPLATES`, `FALLBACK_TOPICS`, `LEAGUES`, `CONTENT_TYPES`, `pickRandom` |
| `src/threads.js` | Threads Graph API client | `createMediaContainer`, `publishMedia`, `postToThreads`, `getThreadsConfig` |
| `.github/workflows/post.yml` | Manual-run GitHub Action; dry_run checkbox; font + npm install; post step | — |
| `package.json` | ESM manifest; `sharp` dep; npm scripts (`dry-run`, `post:*`) | — |
| `.env.example` | Local env template (names only, no values) | — |
| `.gitignore` | Excludes `.env`, `.env.*` (except example), `.tmp-*`, logs, `node_modules` | — |
| `deploy.sh` | One-shot deployer via `gh` CLI (creates repo, sets secrets, first dry-run) | — |
| `README.md` | User-facing docs (setup, secrets, troubleshooting) | — |
| `out/` | Hosted composed images pushed by each run (grows per run) | — |

### Key constants worth knowing

- `content.js`: `DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'`,
  `DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free'`, `ESPN_SCOREBOARD`, `ESPN_LEAGUES`,
  `NEWS_FEEDS` (BBC Sport, Sky Sports, Google News; **BBC Arabic deliberately
  excluded**), `FOOTBALL_RE` / `AMERICAN_FOOTBALL_RE` (topic filtering),
  `NAMED_ENTITIES` (tracked clubs/stars/managers for hallucination grounding),
  `ARABIC_WORDS` (allowlist set used for scoring), `FOOTBALL_TERMS` (hard
  deterministic vocabulary check).
- `images.js`: `BASE_QUERIES` per content type, `AR_TO_EN` (Arabic→English
  keyword table for Openverse), `BLOCKED_IDS` (off-topic Flickr photo IDs).

## 6. Config

### Environment variables / GitHub Secrets (NAMES ONLY — never values)

| Name | Used in | Required for |
|---|---|---|
| `LLM_API_KEY` | `content.js` (`llmConfig`) | All generation |
| `LLM_MODEL` | `content.js` | Override model (default `nvidia/nemotron-3-ultra-550b-a55b:free`) |
| `LLM_BASE_URL` | `content.js` | Optional override of the endpoint |
| `THREADS_ACCESS_TOKEN` | `threads.js` | Real publishing (`--post`) |
| `THREADS_USER_ID` | `threads.js` | Real publishing |
| `BOT_TOPIC` | `index.js` | Optional fixed topic (set by workflow input) |
| `GITHUB_REPOSITORY` | `overlay.js` | Push target (set by Actions runner; fallback `hamzahamad207-art/football-new`) |

`.env.example` lists `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL`,
`THREADS_ACCESS_TOKEN`, `THREADS_USER_ID`, `BOT_TOPIC` — copy to `.env` for
local use. `.env` and `.env.*` are gitignored; **never commit real values**.

### Workflow inputs (`post.yml`, manual "Run workflow")

| Input | Default | Notes |
|---|---|---|
| `content_type` | `random` | choice: random, news, stats, analysis, meme, throwback, fact, quote |
| `topic` | `''` | Arabic or English topical override; blank = auto-picked |
| `dry_run` | `true` | checked = preview only, no Threads post |

Workflow details: `permissions: contents: write` (needed for pushing the
composed image to `out/`), `concurrency: group: post-to-threads,
cancel-in-progress: false`. The image push itself `git pull --rebase
origin main` before `git push origin HEAD:main`.

## 7. How to run

### Via GitHub Actions (the normal way)

1. Open `https://github.com/hamzahamad207-art/football-new/actions`.
2. "The Touchline AR — Post to Threads" → **Run workflow**.
3. Set content type / topic; keep **dry_run checked** to preview.
4. Watch the log; the final line prints the composed-image preview URL
   (`raw.githubusercontent.com/.../out/tl-<ts>.jpg`) — open it in a browser
   to eyeball the Arabic overlay (the agent cannot view images).

### Local commands

```bash
node src/index.js                        # random type, dry-run (default)
node src/index.js -t news --dry-run      # specific type, preview
node src/index.js -t throwback --post    # real publish (needs secrets)
BOT_TOPIC="Barça vs Sevilla" node src/index.js -t news --post
```

Flags: `--type/-t`, `--topic/--match/-m`, `--post/--publish`, `--dry-run`,
`--help/-h`. `npm run dry-run` / `npm run post:<type>` aliases exist.

### Previewing the output image

After any dry-run (local or CI), the composed image lives at
`https://raw.githubusercontent.com/hamzahamad207-art/football-new/main/out/tl-<timestamp>.jpg`.
Open it in a real browser and check: Arabic renders correctly (RTL, connected
letters), no English on the image, no emoji/quote-marks on the headline.

## 8. Hard rules (never break)

1. **100% Arabic output.** Captions and image-embedded text must be Arabic —
   no English/Latin characters anywhere, except inside a verbatim typed
   `FT:/LIVE:/HT:/ET:/NEXT:/BREAKING:/CLOSE:` score header. Foreign names are
   transliterated phonetically into Arabic (e.g. `رافينيا`, `ليفاندوفسكي`).
2. **No invented facts.** No fabricated results, scores, names, quotes,
   transfer rumours, or positions. Nothing may appear in the caption that isn't
   in the article data (header/recap/facts/topic). A derby is a **derby**
   (`ديربي`/المواجهة), never "el clásico" unless it's literally
   Real Madrid vs Barcelona.
3. **Real photos only, never AI.** `--post` aborts if no image is found.
4. **No kids/children images.** URLs containing `kid|chil|youth|minor` are
   rejected in both article and stock paths (`isLikelyKidImage`).
5. **Dry-run before posting.** Real publishing requires the user to explicitly
   approve a concrete post (uncheck `dry_run`). Never post without approval.
6. **Never commit secrets.** `.env`, `.env.*` are gitignored; do not print
   `LLM_API_KEY`, `THREADS_ACCESS_TOKEN`, or `THREADS_USER_ID` in logs/docs.
7. **Don't dispatch multiple runs at once.** The compose-image push and the
   concurrency group mean runs must be applied one at a time; wait for each to
   finish before starting another.
8. **Don't add example-club leakage.** The `news` system prompt's examples
   (Real Madrid, Lewandowski, etc.) must never appear in output unless they're
   in the actual article data.

## 9. Lessons learned (permanent)

- **The free LLM 429s constantly.** Every `chatComplete` call must keep all 5
  retry attempts (the guard checks `attempt < 5`), both for 429/5xx AND network
  timeouts. A previous `attempt <= 3` loop silently quit after the 3rd 429 and
  threw a misleading "after 2 attempts" error.
- **Pace the caption calls.** 700ms between LLM calls prevents burst 429s.
- **`Set` has no `.some()`.** `arabicStems` formerly returned a `Set` before
  being changed to an array — keep it an array.
- **Transliteration-grounding only works with article data.** For canned topics
  (meme/quote/throwback/fact/analysis without recap) there's nothing to ground
  against, so `findUngroundedTransliteration` must return `null` early —
  otherwise every Khaleeji verb ("يركز") triggers 3 regens.
- **Don't trust first-line Latin.** An English word in the first line (e.g. in
  quote/meme headlines) leaks into the composed image. `isFootballOnly` flags
  first-line Latin unless it's a verbatim typed score header.
- **Clean up model artifacts.** `clean()` strips markdown fences, stray quotes,
  and asterisks before the first line becomes the image headline.
- **Push races are real.** Two runs pushing to `out/` will reject each other
  (`! [rejected] HEAD -> main (fetch first)`) unless the push `pull --rebase
  origin main` first. `pushComposedImage` retries up to 4 times.
- **Google-News titles carry a `- Publisher` suffix** — strip it before using
  the title.
- **BBC video pages** (`/videos/`) are English studio graphics, not clean
  photos — the trending picker de-prioritizes them (`rankItem`).
- **Verify your own claims against the code.** Proposed edits from review
  (e.g. name misspelling normalizers) are often *not* committed — check git
  log and file contents before claiming a fix exists.
- **The first line is NOT auto-grounded.** The old assumption "the first line
  IS the article title" died once trending news started rendering Arabic
  headlines. `findUngroundedName` must scan the **whole caption** — an invented
  club inside the headline itself (تشيلسي in a Celtic transfer story) used to
  slip past the body-only scan, and the regen nudge alone couldn't fix it.
- **Questions are optional.** Templates close with an engaging line; a question
  is added only when it's natural. `scorePost` gives a question ending only a
  small edge between two draws and never penalizes a strong non-question closer.
- **`الكلاسيكو` is reserved for RM–Barça.** `findUngroundedClasico` flags the
  word in any caption whose article data doesn't cover both clubs, and the
  regen nudge steers the model to ديربي/المواجهة الكبيرة.
- **The agent can't see images.** Overlay/Arabic-rendering quality must be
  confirmed by the user via the preview URL. Never claim an image "looks
  correct" without a human check.