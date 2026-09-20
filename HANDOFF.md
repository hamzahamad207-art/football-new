# HANDOFF.md — Current State & Session Log (The Touchline AR)

Read this every session *after* AGENTS.md. This file is the latest state and
what changed; AGENTS.md is the permanent knowledge.

---

## 1. Current State

- **Repo**: `hamzahamad207-art/football-new` (public). Local checkout:
  `football-new-main/football-new-main/`.
- **HEAD**: `69eb63a` — "feat: add --republish to re-post the last saved post".
  **Working tree clean** — in sync with `origin/main` after push.
- **Branch**: `main` (synced with `origin/main`). The next GitHub Actions run
  picks up the new code.
- **Re-publish feature**: every run that composes + hosts an image also saves
  the post to `out/last-post.json`; the workflow now has a **"Re-publish the
  last saved post"** checkbox (+ `--republish` CLI flag) that posts that exact
  caption + image with zero regeneration (still gated by `dry_run`).
- **LLM provider: OpenRouter** (`LLM_BASE_URL=https://openrouter.ai/api/v1`),
  model **`nvidia/nemotron-3-ultra-550b-a55b:free`** (Nemotron 3 Ultra, free
  tier). Secrets updated this session via `gh secret set`: `LLM_API_KEY`
  (user's OpenRouter key — **rotate it, see §6**), `LLM_MODEL`, `LLM_BASE_URL`.
- **Node not available locally** — JS changes are validated by running the
  GitHub Actions workflow, never locally. No syntax check was run; review the
  diff carefully or kick a dry-run before posting.
- **What works (tested end-to-end via dry-runs)**: all 7 content types run,
  captions generate in Khaleeji Arabic, real photos are picked, the Arabic
  headline overlay is applied and the composed image is pushed to `out/`
  (`tl-<ts>.jpg`, hosted at `raw.githubusercontent.com/.../main/out/...`).
  Dry-runs do not publish; `--post` publishes via Threads API when secrets are
  set.
- **LLM**: free tier (`nvidia/nemotron-3-ultra-550b-a55b:free` — Nemotron 3
  Ultra via OpenRouter) — free-tier 429s / "provider returned error" happen,
  handled by the 5-attempt retry loop; calls are slower (reasoning tokens,
  ~7s+).
- **Last verified dry-run**: before this session — "Celtic to rekindle Gineitis
  move in January" → Arabic caption → composed `tl-1789893925286.jpg`. That
  run exposed the caption-integrity bugs this session is fixing (see §2).

## 2. Session Summary (what was done this session)

### Latest addition — re-publish the last post (`69eb63a`)

User asked: "can I publish this existing post (the dry-run one I already made)
without generating a new one?" Built a safe, additive feature:

- **Every run persists its result** — `pushComposedImage(file, meta)` writes
  `out/last-post.json` (createdAt, type, topic, caption text, hosted image URL)
  in a separate best-effort commit *after* the image push. The image push stays
  authoritative — a json push hiccup never blocks a post.
- **`--republish` CLI flag** (+ workflow checkbox "Re-publish the last saved
  post"): loads `out/last-post.json` and posts that **exact caption + image**,
  skipping fetch/generate/image/overlay entirely. Dry-run with it = preview of
  the stored post; posting still requires `dry_run` unchecked + Threads secrets.
- **Zero risk to the existing bot**: the normal flow is untouched (meta is
  optional; when absent, `pushComposedImage` behaves exactly as before).
- **Constraint**: `last-post.json` is only written when a composed image is
  actually hosted (the main dry-run case). If image/overlay hosting fails, no
  record is saved (nothing to re-publish) — the user can still post manually.

### Latest session — OpenRouter migration (`6f2e370`)

User asked, in frustration, whether the bot can reach human quality, and which
free/paid models exist right now. Honest answer given: the architecture is fine;
the ceiling was the free code-focused GLM-4.7-Flash writer + heuristic guards +
short-recap input. User chose **OpenRouter free tier** and pasted an OpenRouter
API key.

- **Tested candidates LIVE** (realistic Arabic grounding task with a forcing
  "Celtic/Chelsea" trap): `nvidia/nemotron-3-ultra-550b-a55b:free` worked and
  produced grounded, engaging Khaleeji copy in ~7.5s (no invented clubs, proper
  tone, natural closer). `z-ai/glm-5.2:free` and `qwen/qwen3.8-27b:free`
  returned provider 429s mid-test — rejected as flaky.
- **Shipped**: `content.js` defaults → OpenRouter + Nemotron; `LLM_BASE_URL`
  passed through the workflow (`post.yml`); `max_tokens` 800→1200 (reasoning
  headroom); OpenRouter attribution headers; docs/env/deploy updated
  (Z.ai → OpenRouter everywhere).
- **Secrets updated via `gh`**: `LLM_API_KEY` (OpenRouter key), `LLM_MODEL`,
  `LLM_BASE_URL`.
- **NOT changed**: the grounding/verifier upgrades (full article body, numeric
  containment, judge pass) were deferred — the model jump fixes most quality
  complaints; deterministic containment is next (§7).

### Previous session (`c87857f`)

Goal (user request): **remove the mandatory closing question** — captions
should just be engaging, with a question only when it adds engagement. Plus the
standing backlog: fix the caption guardrails that let the Celtic→Chelsea
disaster through, and commit the reviewed-but-lost normalizers/derby/grammar
rules.

**Shipped in the previous session** (`c87857f`):

- **Closing question is now optional everywhere.** All templates
  (`templates.js`) now instruct an *engaging* closing line (sharp remark,
  prediction, or a natural question) instead of "must end with a question".
  The news system prompt got a 4th shape example that ends WITHOUT a question.
  `scorePost`'s question-ending bonus dropped from +4 to +2 (still slightly
  preferred between two draws, never required).
- **First-line grounding fix (the Celtic→Chelsea gap).** `findUngroundedName`
  now scans the **whole caption, first line included**. The old code assumed
  the first line was the article title; since trending-news posts now render an
  Arabic headline, an invented club *in the headline itself* (عودة تشيلسي…)
  slipped past the body-only scan. Also added to the guard's ground truth:
  `ctx.topic`.
- **Derby/clásico rule now enforced.** New `findUngroundedClasico`: the word
  الكلاسيكو is only allowed when the article data covers both Real Madrid and
  Barcelona (topic escape hatch: a topic literally about الكلاسيكو is allowed).
  Otherwise it's flagged and the regen nudge steers the model to
  ديربي/المواجهة الكبيرة. Wired into `isFootballOnly` and the guarded draw.
- **Name normalizers + entity aliases committed.** New `normalizeNames()`:
  موهريو→مورينيو, وسيميون→وسيميوني, and الدي→الشولو (the last one only when
  the story is about Simeone/Atlético — unconditional replacement would mangle
  الدي as a typo of الذي/التي). `NAMED_ENTITIES` extended: Mourinho now knows
  موهريو; new Simeone/El Cholo pair
  (وسيميوني/سيميوني/الشولو/الدي/simeone/el cholo).
- **Smarter regeneration nudge.** `buildRegenNudge` replaces the old generic
  "ban the name" note: it now tells the model the story's actual topic, to copy
  club/role names verbatim from the data (don't replace one club with another;
  midfielder stays a midfielder), and to use an engaging close.
- **Prompt-level precision + grammar.** News rules (12) name/role-exactness and
  (13) verb-agreement guidance added ("المباراة ما تنتهي", not "ما ينتهي");
  `scorePost` gained a narrow penalty for that exact slip
  (`(المباراة|المواجهة|الجولة|المرحلة)\s+ما ينتهي`). Grammar is a scoring
  bias only — there is still no full verb-agreement validator (see §5.6).

## 3. Decisions & Rationale

| Decision | Why | Alternatives considered |
|---|---|---|
| **Closing question optional** (all templates) | User: "remove the mandatory question at the end. just make the caption engaging and if its more engaging with a question then add it." Mandatory questions made every post look templated. | Keeping the mandate (user rejected); banning questions outright (user wants them when natural). |
| **Full-caption name grounding (incl. line 1)** | An invented club in the Arabic headline escaped the old body-only scan (the old "first line IS the article title" assumption died when headlines went Arabic). `ground` now also includes `ctx.topic`. | Body-only scan (proven insufficient); separate headline scan (redundant — one pass is simpler). |
| **`الكلاسيكو` distributed as a guard + nudge** | User rule: "It's 'derby,' not 'el clásico,' for non-RM-Barça." A hard regex guard is the only reliable way to enforce it. | Prompt-only instruction (model ignores it under free-tier pressure); text replacement `الكلاسيكو→المواجهة الكبيرة` (too blunt — would mangle genuine clásicos). |
| **`normalizeNames` applied inside `make()`** | Fixes are applied to every draw, so the *accepted* caption and its overlay headline always carry the corrected spelling. | Fixing only the final text (missed regen drafts and could double-apply). |
| **`الدي→الشولو` gated on Simeone context** | Unconditional replacement mangles الدي as a typo of الذي/التي in unrelated captions. | Unconditional replace (rejected — too risky). |
| **Smarter regen nudge (topic + verbatim names/roles)** | Banning the wrong name alone didn't fix the Celtic→Chelsea loop; telling the model the real topic and to copy names/roles verbatim gives regens a real chance. | Old generic nudge (proved weak). |
| **Grammar as scoring bias, not hard validator** | A full Arabic verb-agreement validator without a grammar library is unreliable. The narrow feminine-subject pattern only biases which draw wins — zero risk of false rejection. | Hard rejection regex (false-positive risk); nothing (slips survive). |
| **OpenRouter free Nemotron 3 Ultra as writer** | User asked honestly if human-quality output is achievable and chose "free but much stronger". Tested live on a realistic Arabic grounding task: Nemotron 3 Ultra produced grounded, engaging Khaleeji copy (~7.5s) while GLM-5.2/Qwen free 429'd. `content.js` stays provider-agnostic (env overrides), so a later switch to a paid frontier model is a secrets-only change. | Staying on GLM-4.7-Flash (low quality ceiling); paid frontier (rejected for now); adding more heuristics on top of a weak writer (band-aid). |
| **Persisted last post + `--republish`** | User wanted to publish an existing dry-run post without regenerating. Persisting the exact caption + hosted image URL (committed to `out/last-post.json` on every composed push) makes re-publishing deterministic — no re-roll of the dice. Persisted *after* the image push as a separate commit so it can never block posting. | Re-running with the same topic and hoping for the same caption (non-deterministic); manual copy-paste every time (no); a `last-post.json` written before the push (risky if the push fails). |

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

14. **Body-only name grounding** — Symptom: invented clubs in the Arabic
    headline (the Celtic→Chelsea caption opened with عودة تشيلسي…) escaped
    `findUngroundedName` because it stripped line 1. Fix: scan the entire
    caption including the first line. **Learned**: the first line is not
    "always the article title" anymore — it's the model's own Arabic headline,
    and must be grounded like everything else.

15. **Unconditional `الدي`→`الشولو` replacement** — Rejected *before* commit:
    in captions not about Simeone, `الدي` is usually a typo of `الذي`/`التي`
    and blind replacement corrupts them. Fix: replace only when the story is
    Simeone/Atlético-related (`normalizeNames` context gate). **Learned**:
    text normalizers need context gates, not global regexes.

16. **Sticking with Z.ai GLM-4.7-Flash** — Symptom: free-tier output was
    repetitive ("Gineitis targeted… Gineitis is set for a potential move…"),
    extrapolated beyond the recap, and force-closed with a question. The
    quality ceiling is the **model**, not the pipeline. Fix: switched the
    writer to OpenRouter free `nvidia/nemotron-3-ultra-550b-a55b:free`
    (Nemotron 3 Ultra), tested live (grounded, Khaleeji-engaging copy, ~7.5s).
    GLM-5.2/Qwen free variants on OpenRouter were rejected: provider 429s
    mid-test. **Learned**: upgrade the writer model before piling on more
    heuristic guards; it's the dominant quality lever.

## 5. Known Issues / Open Bugs

1. **LLM occasionally produces flawed captions that pass guardrails.**
   The Celtic→Chelsea failure was addressed this session (first-line grounding
   + role-exactness nudges + smarter regen nudge), but guardrails are still
   probabilistic: an entirely-new wrong name that is neither tracked nor
   romanizable can still survive. **How to reproduce**: run `news` type
   repeatedly; pick a run whose topic involves a transfer/player. Not
   deterministic.
2. **Guard "accept as-is" escape hatch.** After 3 regens a still-flagged
   caption is accepted as-is (`⚽ Guard: caption still flagged after 3 attempts
   — accepting as-is.`). Combined with (1), bad captions can be published when
   the user unchecks dry-run. This is intentional (must post something) but
   risky. The smarter nudge hopefully makes regens land more often.
3. **429 storms can interrupt a mid-run regeneration.** The "Regeneration
   interrupted after retries … using last caption" path keeps the previous
   caption even if it was flagged. Not an open bug per se — mitigation for
   the free tier.
4. **Name normalizers are narrow.** Only the reviewed set is committed
   (Mourinho/Simeone/El Cholo). Other misspellings from future runs will not
   be auto-corrected — add them to `normalizeNames` + a `NAMED_ENTITIES` alias
   when they surface.
5. **Derby/clásico rule is enforced now**, but only as a guard + regen nudge.
   If 3 regens fail, the accept-as-is path can still pass a الكلاسيكو misuse
   through (rare — the nudge is explicit).
6. **No full plural-verb grammar fix.** The narrow
   `(المباراة|المواجهة|الجولة|المرحلة)\s+ما ينتهي` penalty handles the most
   common slip; other agreement errors are still unvalidated. The news prompt
   now also instructs agreement (rule 13).
7. **`isLikelyKidImage` is URL-string based.** It can miss kids photos whose
   URLs don't contain kid/children/youth words, and can false-positive on
   unrelated words. Adequate but heuristic.
8. **Node is not installed locally** — any new JS must be validated through
   the GitHub Actions workflow (each run ~4-5 min).
9. **Local `main` was one commit ahead of `origin/main`** — resolved by the
   `6f2e370` push this session.
10. **OpenRouter free-tier quota/429s.** Without credits, free models allow
    ~50 requests/day per model; a heavy `news` run (2 draws + regens +
    classifier ≈ 10–16 calls) can approach it, and "provider returned error"
    happens mid-busy-day (GLM-5.2/Qwen failed during testing). The 5-attempt
    backoff absorbs most; adding ≥$10 OpenRouter credits raises the free cap
    to 1000/day. Nemotron 3 Ultra emits reasoning tokens — each call is slower
    (tested ~7.5s) than GLM flash; runs will take longer.
11. **`last-post.json` is a public file in the repo** (`out/last-post.json`) —
    it contains only the caption text + image URL + type/topic/timestamp (no
    secrets). Fine to be public, but don't ever add token/secret fields to it.

## 6. Unverified Claims & Things Needing a Human Check

- **Arabic rendering quality of the composed images is UNVERIFIED.**
  The agent cannot view images. Arabic overlay correctness (ligatures, RTL,
  no missing letters) has only been inferred from pixel-diff logic, not
  eyeballed. **You must open a preview URL and confirm it looks right**, e.g.
  `https://raw.githubusercontent.com/hamzahamad207-art/football-new/main/out/tl-1789893925286.jpg`
  (latest news dry-run) and `.../out/tl-1789891171454.jpg` (earlier news run).
- **THIS SESSION'S CHANGES ARE UNVERIFIED END-TO-END.** `c87857f` (optional
  question endings, full-caption grounding, clasico guard, normalizers) has
  NOT been run in CI yet. It needs a dry-run after being pushed to confirm:
  captions end engagingly (sometimes without a question), no new false-positive
  regen loops, and normalizers don't mangle text.
- **The "Genesis" جيل زد test post**: UNKNOWN whether an early test post
  actually published to Threads. If it did, it needs to be deleted from the
  page. Please check your Threads profile.
- **Threads publishing path** (`postToThreads` with real image URL) has been
  written but its success end-to-end after the overlay feature is UNVERIFIED —
  the last confirmed live post predates the overlay changes. A publish run
  should be approved manually and then confirmed on the Threads page.
- **`LLM_MODEL` / `LLM_BASE_URL` / `LLM_API_KEY` were updated this session** to
  OpenRouter + Nemotron (`nvidia/nemotron-3-ultra-550b-a55b:free`) via
  `gh secret set`. Secret values can't be read back — assume what's set is
  authoritative.
- **OpenRouter migration UNVERIFIED end-to-end.** `6f2e370` has not been run
  in CI. A dry-run is required to confirm: Nemotron captions pass all guards
  (no false-positive regen loops from a stronger model), the overlay headline
  stays Arabic, and free-tier 429s don't stall the run.
- **Re-publish feature UNVERIFIED in CI** (`69eb63a`): confirm a normal dry-run
  prints "♻️ last-post.json saved", then a `--republish` dry-run reads and
  prints the exact stored post. (First real re-publish happens later with user
  approval.)
- **SECURITY — rotate the OpenRouter key.** The user pasted the key in the chat
  transcript during this session. Once the migration is confirmed working, the
  user should rotate it at https://openrouter.ai/keys and we re-set the
  `LLM_API_KEY` secret (never commit it).

## 7. Next Steps (prioritized)

1. **Run a dry-run in CI on `origin/main`** (now carries `c87857f` +
   `6f2e370` + `69eb63a`) to validate: Nemotron captions are grounded and
   engaging (no repeated lines, no forced questions), no false-positive regen
   loops, OpenRouter migration works end-to-end (free-tier 429s aside), and
   the run prints "♻️ last-post.json saved (re-publish ready)".
2. **Test the re-publish flow**: a second dry-run with **"Re-publish the last
   saved post"** checked should print the exact stored post (no generation).
   Only then, with explicit user approval, re-publish for real (`dry_run`
   unchecked).
3. **Build the grounding upgrade** (deferred this session): feed the *full
   article body* into the news prompt (not just the recap/summary), add
   deterministic number/entity containment (every number/club/position in the
   caption must appear in the article), and optionally an LLM-as-judge verify
   pass. The model jump fixes most quality issues; this closes the rest.
4. **Rotate the OpenRouter key** (it was pasted in chat) and re-set the
   `LLM_API_KEY` secret.
5. **Confirm the latest composed image** (the next fresh dry-run) — open the
   preview URL and verify the Arabic overlay looks correct.
6. **Check Threads for the "Genesis" جيل زد test post** and delete it if it
   exists.
7. **On explicit user approval** of a specific post, run the workflow with
   `dry_run` unchecked, then confirm the post is live on Threads (also
   verifies the real publish path with the overlay).
8. **Collect new failure samples.** Each run may surface new misspellings /
   guard gaps: add them to `normalizeNames` + `NAMED_ENTITIES` / allowlists.
9. **Flush old composed images?** `out/` grows by one image per run. Allowed,
   but review disk/repo size periodically; optionally prune old `tl-*.jpg`.
10. **Consider a scheduled cron** (commented out in `post.yml`) only if the
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
- **Captions should be engaging, not formulaic.** NO mandatory closing
  question anymore (since this session): make the caption engaging, and only
  add a question if it makes the post more engaging.
- **Real photos only, never AI.** If there's no image, don't post
  (`--post` must abort). No kids images.
- **I run workflows manually** by clicking "Run workflow" on the GitHub repo —
  that's the intended, correct way to run. Don't schedule without asking.
- **Stay factual over hype** — hype tone is fine, invented facts are not.
- **Keep the 700ms pacing** to reduce free-tier 429s only if it doesn't mess
  things up; do not trade away reliability for speed.
- **Don't commit secrets, ever.**