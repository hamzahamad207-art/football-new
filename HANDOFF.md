# HANDOFF.md — Current State & Session Log (The Touchline AR)

Read this every session *after* AGENTS.md. This file is the latest state and
what changed; AGENTS.md is the permanent knowledge.

---

## 1. Current State

- **Repo**: `hamzahamad207-art/football-new` (public). Local checkout:
  `football-new-main/football-new-main/`.
- **HEAD**: `e106747` — "image: filter likely-kid URLs (kids/children/youth)
  in both article and stock photo paths". **Working tree clean**
  (`git status` → "nothing to commit, working tree clean").
- **Branch**: `main`, up to date with `origin/main`.
- **Node not available locally** — JS changes are validated by running the
  GitHub Actions workflow, never locally.
- **What works (tested end-to-end via dry-runs)**: all 7 content types run,
  captions generate in Khaleeji Arabic, real photos are picked, the Arabic
  headline overlay is applied and the composed image is pushed to `out/`
  (`tl-<ts>.jpg`, hosted at `raw.githubusercontent.com/.../main/out/...`).
  Dry-runs do not publish; `--post` publishes via Threads API when secrets are
  set.
- **LLM**: free tier (`glm-4.7-flash` pinned via `LLM_MODEL` secret) — 429s are
  frequent but handled by the 5-attempt retry loop.
- **Last verified dry-run** (news): headline "Celtic to rekindle Gineitis move
  in January" → Arabic caption → composed `tl-1789893925286.jpg` pushed and
  preview URL printed.

## 2. Session Summary (what was done this session)

Goal: make the bot produce TouchlineX-style Khaleeji Arabic posts with **real
photos that carry Arabic text** (user requirement: "if there's gonna be text
on the images, it should be translated in arabic — the image should be redone
so it has arabic text instead of english"), with **zero invented facts/names**,
100% Arabic output, and dry-run protection.

**Shipped in this session** (commits, newest first in git log):

- `e106747` — kid-image filter: `isLikelyKidImage()` rejects URLs containing
  `kid|chil|youth|minor` in both article and Openverse stock paths.
- `74a607a` — first-line Latin guard: `isFootballOnly` flags Latin in line 1
  unless a verbatim `FT:/LIVE:/HT:/ET:/NEXT:/BREAKING:/CLOSE:` typed header
  (blocks English leaking into quote/meme headlines → prevents English on the
  composed image).
- `01851ce` — strip leftover markdown asterisks from captions (`clean()`).
- `2e276f3` — network-timeout retries also run to attempt 5 (was throwing on
  attempt 3).
- `151d80d` — skip transliteration-grounding when no article data (stops regen
  thrash on meme/quote/analysis posts).
- `382e555` — compose-image push rebases onto `origin/main` before each push
  (fixes `! [rejected] HEAD -> main (fetch first)` race); strip stray quotes
  from overlays/captions.
- `38b4e17` — LLM retry loop runs all 5 attempts (3rd 429 was silently giving
  up; guard checks `attempt < 5` so the loop must reach 5).
- `307afd3` — **Arabic text overlay:** `src/overlay.js` (Tajawal font embedded
  as a data: URI in an SVG + sharp; librsvg/Pango handles RTL shaping), wired
  into `src/index.js`, image hosted by pushing to `out/`.
- `79fecbf`, `1a5cad1`, `697145a`, `1cf31cf`, `2117f33`, `b2280c1`, `b0459c8`,
  `232a520`, `ddd519e`, `731cfb7`, `fb4e9bb`, `645895c` — earlier guard/quality
  work: vocabulary allowlists, headline-verb allowlist, 5x 429 backoff + 700ms
  pacing, skip classifier when anchored, keep draft on mid-flight 429, allow
  `رأيكم`/`ذهول` + pronoun suffixes, stems-as-array fix, transliteration
  grounding, ban example-club leakage, gibberish-token scoring penalty, ranking
  top-league reports, 90s LLM timeout + network retry.

**Also in this session**: a dry-run was run that picked "Celtic to rekindle
Gineitis move in January". The caption it produced contained errors the user
flagged (see §6 Unverified / §7 Next Steps) but the run itself completed and
pushed its composed image.

## 3. Decisions & Rationale

| Decision | Why | Alternatives considered |
|---|---|---|
| **Arabic overlay instead of translating baked-in image text** | Real photos can't have their English studio graphics pixel-translated without AI editing (banned). TouchlineX-style "redo" = keep the real photo, stamp Arabic headline text as the new bottom band. | OCR+inpainting (impossible reliably, AI editing banned); rejecting all text-bearing images (none clean enough on Openverse). |
| **Tajawal font embedded as `data:` URI in the SVG** | `sharp` renders SVG via librsvg; Pango needs an actual font to shape Arabic ligatures/RTL. Embedding as base64 in `@font-face src:url(data:font/ttf;base64,...)` makes it work without any system font install. | system-installed font (worked on the runner but not guaranteed/portable). |
| **5 retries with growing backoff `[2.5s, 5s, 10s, 20s]`** | Free-tier Z.ai 429s (code 1305) are constant; old `attempt <= 3` loop contradicted the `attempt < 5` guard and silently quit. 5 attempts keeps runs rare-failure. | 3 attempts (failed); infinite retry (run time explodes). |
| **Compose-image push rebases onto origin/main** | Every run pushes to the same repo; concurrent/consecutive runs advance `main` and a straight push is rejected. `pull --rebase origin main` then `push origin HEAD:main`, 4 attempts. | Straight push (failed with `! [rejected] HEAD -> main`). |
| **Images go through the repo `out/` + raw.githubusercontent URL** | Threads API requires a publicly reachable `image_url`; the composed JPEG isn't online anywhere else. The repo is public, so `main/out/tl-*.jpg` works. | Third-party image hosts (account/size constraints, unreviewed). |
| **740ms pacing (700ms in code) between LLM calls** | Free tier trips 429s when caption draws + regens + classifier fire back-to-back (~16 calls/run). | No pacing (chronic 429s); faster pacing (user-approved 700ms kept). |
| **`findUngroundedTransliteration` returns null when no article data** | Canned types have no English ground truth; grounding every token would flag real Khaleeji verbs and force 3 regens every time. | Running it regardless (regen thrash). |
| **First-line Latin banned unless verbatim typed header** | The first line becomes the composed image's headline; English there = English on the image (user requirement). | Allow Latin anywhere (violates requirement). |
| **`isLikelyKidImage` string filter** | User: "THE IMAGE IS TERRIBLE. it's of kids!!" — cheap deterministic filter. | ML image classification (no model budget, nothing installed). |
| **BBC Arabic excluded from NEWS_FEEDS** | Its feed mixes general/politics news, risk of non-football posts. | Including it (bad posts). |
| **ESPN data first, trending RSS second** (for news) | Live/recent matches with API-given scores are the most factually-anchored; trending headlines are fallback with article summary + photos. | Canned topics for news (let the model invent garbage). |
| **Two independent caption draws for news, keep the better score** | Smooths out free-tier gibberish-token glitches (e.g. `_performance`). | Single draw (higher glitch rate). |
| **`thinking: { type: 'disabled' }` for Z.ai endpoints** | GLM-4.5+ spends the token budget on reasoning content, leaving `content` empty. | Nothing (first run broke on empty content). |
| **`--post` aborts without an image** | TouchlineX-style posts must ship with a photo. | Text-only publish (user doesn't want it). |
| **Manual `workflow_dispatch` with `dry_run` default true** | User runs workflows manually; safe-by-default posting. | Scheduled auto-posting (off by default, commented out in `post.yml`). |

## 4. Tried and Rejected

This is the most important section. Each item: what we tried, the exact
error/symptom, why it failed, what we learned.

1. **Straight `git push` of composed images (no rebase)** — Symptom:
   `! [rejected] HEAD -> main (fetch first)` when a run pushed while `main`
   had advanced (earlier runs also push to `out/`). Fix: `git pull --rebase
   origin main` before push, retry up to 4× (`overlay.js`,
   `pushComposedImage`). **Learned**: shared-repo pushes must rebase first.

2. **`attempt <= 3` retry loop in `chatComplete`** — Symptom: after the 3rd
   429 the function threw `LLM returned empty content after 2 attempts`
   (misleading count; also ran fewer times than the `attempt < 5` guard
   checked). Fix: loop bound `attempt <= 5` (both the 429/5xx branch and the
   network-timeout catch branch). **Learned**: keep loop bounds and guard
   checks in sync; retries must actually run to the last attempt.

3. **Network-timeout throwing on attempt 3** — Symptom: `fetch` timing out on
   attempt 3 aborted the whole retry chain. Fix: the catch block also retries
   while `attempt < 5`. **Learned**: network errors are transient too — treat
   them like 429s.

4. **Transliteration-grounding on canned topics** — Symptom: meme/quote/
   throwback/fact runs repeatedly hit `⚽ Guard: ungrounded transliteration
   token "تخيلوا"/"سيدفع"/... — regenerating (1/3)... (2/3)... (3/3)...`,
   wasting 3 regens per post. Fix: `findUngroundedTransliteration` returns
   `null` when there's no article data (`recap`/`facts`). **Learned**: a guard
   that can't be satisfied is worse than no guard — gate it on data
   availability.

5. **Latin text leaking into the composed image headline** — Symptom: quote
   and meme composed images showed English words (user: "the title of the
   image is in english btw too"); the first line became the overlay text.
   Fix: `isFootballOnly` flags Latin in line 1 unless it's a verbatim typed
   score header; `prepOverlayText` returns `''` if any Latin remains.
   **Learned**: the overlay only ever receives the first line — first-line
   purity is the critical guard.

6. **The overlay trying to render emoji / unmatched quotes** —
   Symptom/Fix: `prepOverlayText` strips emoji ranges (no color-emoji font in
   librsvg), quote marks, and leading `FT:/LIVE:` labels before rendering.
   **Learned**: sanitize *before* the SVG is built.

7. **`arabicStems` returning a `Set`** — Symptom: `stems.some(...)` threw
   "Set has no .some" (a JS runtime error in CI). Fix: return an array
   (`[...out]`). **Learned**: don't assume a helper's return type; it was
   previously coerced elsewhere.

8. **Allowlist gaps causing false-positive guard regens** — Symptom: mandatory
   closing question words (`رأيكم`), astonishment (`ذهول`), pronoun-suffixed
   forms (`كم/ك`), and common words (`تأثير`, `خطوط`, `جدا`) were flagged as
   unknown/invented tokens, forcing unnecessary regenerations. Fixes:
   `1cf31cf` (allowlist `رأيكم`/`ذهول` + pronoun suffixes),
   `79fecbf` (allowlist `تأثير/خطوط/جدا`), `2117f33` (stems array),
   `1a5cad1` (headline-verb allowlist). **Learned**: vocab allowlists need
   real-run feedback to stop false positives.

9. **Model "thinking" consuming the whole token budget** — Symptom: first runs
   produced empty `content` because GLM-4.5+ put everything in
   `reasoning_content`. Fix: `body.thinking = { type: 'disabled' }` for
   Z.ai/BigModel endpoints. **Learned**: free GLM flash models need thinking
   disabled to actually emit text.

10. **Canned news topics letting the model invent results** — Symptom (earlier
    sessions): posts cited imaginary results ("Copa del Rey final" style
    garbage). Fix: `fetchNewsContext` for `news` uses only live/real data
    (ESPN match or trending RSS headline with real summary); it throws cleanly
    if no fresh data exists rather than guessing. **Learned**: never give the
    model a chance to invent scores.

11. **English gibberish tokens in LLM output** — Symptom: occasional glitch
    tokens like `_performance` / nonsense words. Fixes: `scorePost` penalizes
    code/English artifacts (`-999`), `232a520` increases gibberish penalty,
    `fb4e9bb` recognizes Raphinha spellings, double-draw for news keeps the
    cleaner caption. **Learned**: score and pick, don't just accept the first
    draw.

12. **Popup images / off-topic stock photos** — Symptom: Openverse ranked the
    "green mascot man in a stadium" for broad football queries; tiny/icons/
    avatars passed the URL check. Fixes: `BLOCKED_IDS`, `isValidImageUrl`
    requires `content-type: image/*` and size ≥ 12KB. **Learned**: validate
    fetchability *and* block known bad candidates.

13. **BBC Arabic in the news feeds** — Symptom/Rationale: its feed carries
    general/politics news, so non-football items could become posts.
    Decision: exclude it; use BBC *Sport*, Sky Sports, Google News.
    **Learned**: scope all feeds to football.

## 5. Known Issues / Open Bugs

1. **LLM occasionally produces flawed captions that pass guardrails.**
   A dry-run produced "عودة تشيلسي لاستكمال صفقة جينيتيس في شهر يناير" for a
   Celtic transfer story — wrong club (Chelsea vs Celtic), wrong position
   (called a midfielder a "defender"), and a wrong manager context — yet the
   guards (name-grounding, transliteration) didn't catch all of it.
   **How to reproduce**: run `news` type repeatedly; pick a run whose topic
   involves a transfer/player. Not deterministic.
2. **Guard "accept as-is" escape hatch.** After 3 regens a still-flagged
   caption is accepted as-is (`⚽ Guard: caption still flagged after 3 attempts
   — accepting as-is.`). Combined with (1), bad captions can be published when
   the user unchecks dry-run. This is intentional (must post something) but
   risky.
3. **429 storms can interrupt a mid-run regeneration.** The "Regeneration
   interrupted after retries … using last caption" path keeps the previous
   caption even if it was flagged. Not an open bug per se — mitigation for
   the free tier.
4. **No Simeone/Mourinho spelling normalizers exist.** Mourinho's Arabic
   (`مورينيو`) is correct in `NAMED_ENTITIES`; but proposed fixes like
   `وسيميوني` for Simeone and `الشولو` for "El Cholo" were **never committed**.
   Any caption from the LLM containing misspelled foreign names won't be
   auto-corrected.
5. **Derby/clásico mislabeling not yet guarded.** `الكلاسيكو` is only a vocab
   word + fallback topic; there's no rule enforcing "derby ≠ el clásico
   unless RM–Barça" in the prompts. (The earlier HANDOFF draft over-claimed
   this fix — it is NOT in the code.)
6. **No plural-verb grammar fix.** Proposed "ما ينتهي"→"ما تنتهي" check was
   never added to `scorePost`; the code has no verb-agreement validation.
7. **`isLikelyKidImage` is URL-string based.** It can miss kids photos whose
   URLs don't contain kid/children/youth words, and can false-positive on
   unrelated words. Adequate but heuristic.
8. **Node is not installed locally** — any new JS must be validated through
   the GitHub Actions workflow (each run ~4-5 min).

## 6. Unverified Claims & Things Needing a Human Check

- **Arabic rendering quality of the composed images is UNVERIFIED.**
  The agent cannot view images. Arabic overlay correctness (ligatures, RTL,
  no missing letters) has only been inferred from pixel-diff logic, not
  eyeballed. **You must open a preview URL and confirm it looks right**, e.g.
  `https://raw.githubusercontent.com/hamzahamad207-art/football-new/main/out/tl-1789893925286.jpg`
  (latest news dry-run) and `.../out/tl-1789891171454.jpg` (earlier news run).
- **The "Genesis" جيل زد test post**: UNKNOWN whether an early test post
  actually published to Threads. If it did, it needs to be deleted from the
  page. Please check your Threads profile.
- **Second dry-run caption was accepted despite flags** — the exact post text
  and image for the Gineitis/Celtic run (`tl-1789893925286.jpg`) are
  UNVERIFIED for correctness; it was a dry-run so nothing was published.
- **Threads publishing path** (`postToThreads` with real image URL) has been
  written but its success end-to-end after the overlay feature is UNVERIFIED —
  the last confirmed live post predates the overlay changes. A publish run
  should be approved manually and then confirmed on the Threads page.
- **`LLM_MODEL` secret value** is `glm-4.7-flash` per prior context, but
  secret values can't be read — assume whatever is set in GitHub Secrets is
  authoritative.

## 7. Next Steps (prioritized)

1. **Fix caption spelling/misnaming guardrails in code** (from the Gineitis
   review). Not committed:
   - Club-name grounding is weak for transfer stories where the article's
     teams aren't in `NAMED_ENTITIES`. Consider adding a "the club in the
     headline is the subject" rule: if the article is about Celtic, `تشيلسي`
     (a known entity!) should be caught by `findUngroundedName` once Celtic
     is in the data — verify why it wasn't.
   - Player position accuracy: the prompt already says don't invent facts;
     consider instructing the model to reflect the exact wording of the recap
     (midfielder, not defender) rather than paraphrasing roles.
   - Add name normalizer suggestions: `موهريو`→`مورينيو`, `وسيميون`→`وسيميوني`,
     `الدي`→`الشولو`, plus a "derby not clásico" rule
     (`الكلاسيكو` only for RM–Barça; else `المواجهة الكبيرة`) and plural-verb
     agreement (`ما تنتهي`). These were reviewed and approved but never
     committed.
2. **Confirm the latest composed image** (`tl-1789893925286.jpg` or the next
   fresh dry-run) — open the preview URL and verify the Arabic overlay looks
   correct.
3. **Check Threads for the "Genesis" جيل زد test post** and delete it if it
   exists.
4. **On explicit user approval** of a specific post, run the workflow with
   `dry_run` unchecked, then confirm the post is live on Threads (also
   verifies the real publish path with the overlay).
5. **Flush old composed images?** `out/` grows by one image per run. Allowed,
   but review disk/repo size periodically; optionally prune old `tl-*.jpg`.
6. **Consider a scheduled cron** (commented out in `post.yml`) only if the
   user asks — for now posting is manual.

## 8. My Preferences (the user)

- **Dry-run default.** I prefer safe previews. Real publishing requires my
  explicit approval of a concrete post (`dry_run=false`); don't post on my
  behalf without asking.
- **Khaleeji Arabic, 100% Arabic.** Posts must be in Gulf Arabic, whole post
  in Arabic, no Latin letters anywhere; any text on images must be Arabic.
- **No invented facts.** It's "derby," not "el clásico," for non-RM-Barça.
  Fix spelling of names/nicknames. No made-up names, scores, positions, or
  quotes.
- **Real photos only, never AI.** If there's no image, don't post
  (`--post` must abort). No kids images.
- **I run workflows manually** by clicking "Run workflow" on the GitHub repo —
  that's the intended, correct way to run. Don't schedule without asking.
- **Stay factual over hype** — hype tone is fine, invented facts are not.
- **Keep the 700ms pacing** to reduce free-tier 429s only if it doesn't mess
  things up; do not trade away reliability for speed.
- **Don't commit secrets, ever.**