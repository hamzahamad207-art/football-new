// Main orchestrator — picks a content type, fetches news context, generates
// Khaleeji Arabic text, fetches a matching image, posts to Threads.
//
// Usage:
//   node src/index.js                                  # random type, dry-run
//   node src/index.js --type news                      # specific type
//   node src/index.js --type news --topic "Barça vs Sevilla"
//   node src/index.js --post                           # actually post
//   node src/index.js --republish --post               # re-publish the last saved post
//   BOT_TOPIC="Barça vs Sevilla" node src/index.js -t analysis --post

import { CONTENT_TYPES, pickRandom, TEMPLATES } from './templates.js';
import { fetchNewsContext, generatePostText, newsTitleKey } from './content.js';
import { pickImageForContent } from './images.js';
import { postToThreads } from './threads.js';
import { applyArabicOverlay, pushComposedImage } from './overlay.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { type: 'random', topic: '', post: false, dryRun: true, listTypes: false, republish: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--type' || a === '-t') {
      args.type = argv[++i];
    } else if (a === '--topic' || a === '--match' || a === '-m') {
      args.topic = argv[++i] || '';
    } else if (a === '--post' || a === '--publish') {
      args.post = true;
      args.dryRun = false;
    } else if (a === '--dry-run') {
      args.dryRun = true;
      args.post = false;
    } else if (a === '--republish') {
      args.republish = true;
    } else if (a === '--list' || a === '--help' || a === '-h') {
      args.listTypes = true;
    }
  }
  // Allow BOT_TOPIC env var as fallback (used by GitHub Actions workflow)
  if (!args.topic && process.env.BOT_TOPIC) {
    args.topic = process.env.BOT_TOPIC;
  }
  return args;
}

function printHelp() {
  console.log(`
The Touchline AR — Threads soccer bot

Usage:
  node src/index.js [options]

Options:
  --type, -t <type>     Content type: ${CONTENT_TYPES.join(', ')} or "random" (default)
  --topic, -m <text>    Focus on a specific match/player/topic
                        (e.g. --topic "Barcelona vs Sevilla")
                        Falls back to BOT_TOPIC env var if not set.
  --post                Actually publish to Threads (requires THREADS_ACCESS_TOKEN + THREADS_USER_ID)
  --dry-run             Print the post + image URL without posting (default)
  --republish           Re-publish the last saved post (exact caption + image,
                        saved by every run that composed+hosted an image)
  --help, -h            Show this help

Environment variables:
  THREADS_ACCESS_TOKEN  Threads long-lived access token (required with --post)
  THREADS_USER_ID       Threads user id (numeric, required with --post)
  BOT_TOPIC             Same as --topic (used by the GitHub Actions workflow)

Examples:
  node src/index.js --dry-run                                      # preview random post
  node src/index.js -t news --topic "Barça vs Sevilla" --dry-run   # preview a focused post
  node src/index.js -t analysis -m "محمد صلاح" --post               # post tactical analysis
  node src/index.js --republish --dry-run                          # preview the saved post
  node src/index.js --republish --post                             # re-publish it for real
  BOT_TOPIC="Al-Hilal vs Al-Nassr" node src/index.js -t news --post # env-var flavor
`);
}

/** Load the last post saved by a previous run (out/last-post.json). */
function loadLastPost() {
  const file = path.join(process.cwd(), 'out', 'last-post.json');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      'No saved post found (out/last-post.json). Run a normal dry-run first — ' +
      'every run that composes+hosts an image saves the post for re-publishing.'
    );
  }
  let post;
  try {
    post = JSON.parse(raw);
  } catch {
    throw new Error(`Saved post file is corrupted: ${file} — run a new dry-run first.`);
  }
  if (!post?.text) {
    throw new Error('Saved post is missing its text — run a new dry-run first.');
  }
  return post;
}

/** Load the previously-posted story history (out/news-seen.json), if any. */
function loadNewsSeen() {
  try {
    const raw = readFileSync(path.join(process.cwd(), 'out', 'news-seen.json'), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.listTypes) {
    printHelp();
    return;
  }

  // ── Re-publish the last saved post (no generation, exact caption + image) ──
  if (args.republish) {
    const post = loadLastPost();
    console.log(`────── The Touchline AR — RE-PUBLISH ──────`);
    console.log(`Mode: ${args.post ? 'LIVE POST' : 'DRY RUN'}`);
    if (post.createdAt) console.log(`Saved: ${new Date(post.createdAt).toLocaleString()}`);
    if (post.type) console.log(`Content type: ${post.type}`);
    if (post.topic) console.log(`Topic: ${post.topic}`);
    console.log(`── Post text ──\n${post.text}\n──────────────`);
    console.log(`🖼️  Image: ${post.imageUrl || '(text-only post)'}`);
    if (args.post) {
      if (!process.env.THREADS_ACCESS_TOKEN || !process.env.THREADS_USER_ID) {
        console.error(
          '❌ --republish --post requested but THREADS_ACCESS_TOKEN / THREADS_USER_ID are not set.'
        );
        console.error('   Set them as environment variables or GitHub Secrets.');
        process.exit(1);
      }
      const { postId } = await postToThreads({ text: post.text, imageUrl: post.imageUrl || null });
      console.log(`\n✅ Re-published successfully! Post id: ${postId}`);
    } else {
      console.log(`ℹ️  Stored post preview. Re-run with --republish --post to publish this exact post.`);
    }
    return;
  }

  // Resolve content type
  let type = args.type;
  if (type === 'random' || !CONTENT_TYPES.includes(type)) {
    type = pickRandom(CONTENT_TYPES);
    console.log(`🎲 Randomly picked content type: "${type}"`);
  }
  console.log(`────── The Touchline AR ──────`);
  console.log(`Content type: ${type} (${TEMPLATES[type]?.label || '?'})`);
  if (args.topic) console.log(`Focus topic: ${args.topic}`);
  console.log(`Mode: ${args.post ? 'LIVE POST' : 'DRY RUN'}`);
  console.log(`──────────────────────────────`);

  // 1. Fetch news / context (pass topic override if provided). News runs also
  // carry the history of previously-posted stories so the picker skips repeats.
  const history = type === 'news' ? loadNewsSeen() : [];
  const ctx = await fetchNewsContext(type, { topicOverride: args.topic, history });
  console.log(`📋 Topic: ${ctx.topic}`);
  if (ctx.header) console.log(`   Header: ${ctx.header}`);
  if (ctx.summary) console.log(`   Summary: ${ctx.summary.slice(0, 100)}...`);

  // 2. Generate Arabic post text via LLM
  const text = await generatePostText(type, ctx);
  console.log(`\n📝 Post text (${text.length} chars):\n${text}\n`);

  // 3. Fetch image
  const { imageUrl } = await pickImageForContent(type, ctx);

  // 3b. "Redo" the image with Arabic text (user requirement): download the real
  // photo, stamp the post's Arabic headline onto it, host it in the public repo
  // (out/) so Threads can fetch it. If that fails, post the original real photo.
  let publishImageUrl = imageUrl;
  if (imageUrl) {
    console.log(`🖼️  Image URL: ${imageUrl}`);
    const headerText = String(text || '').split('\n')[0] || '';
    try {
      const composed = await applyArabicOverlay(imageUrl, headerText);
      if (composed) {
        // Remember which story we posted so future news runs skip it (exact
        // topics the user typed are their explicit choice — never recorded).
        const extraFiles = {};
        if (type === 'news' && !args.topic) {
          const key = newsTitleKey(ctx.topic || '');
          let next = [...history];
          if (key && !next.some((e) => e && e.key === key)) {
            next = [{ title: ctx.topic || '', key, ts: Date.now() }, ...next];
          }
          next = next.slice(0, 200);
          extraFiles['news-seen.json'] = JSON.stringify(next, null, 2);
        }
        // Save the post alongside the hosted image so `--republish` can post
        // this exact caption + image later without regenerating anything.
        const meta = {
          createdAt: new Date().toISOString(),
          type,
          topic: ctx.topic || '',
          text,
          extraFiles,
        };
        const previewUrl = await pushComposedImage(composed.file, meta);
        if (previewUrl) {
          publishImageUrl = previewUrl;
          console.log(
            `🖼️  Arabic text added to photo (${composed.width}x${composed.height}, ${composed.lines} line(s))`
          );
          console.log(`   Composed photo: ${publishImageUrl}`);
        } else {
          console.warn(`⚠️  Arabic overlay composed but could not be hosted — using original photo.`);
        }
      } else {
        console.log(`⚠️  Arabic overlay skipped (text not Arabic or image/font issue) — using original photo.`);
      }
    } catch (err) {
      console.warn(`⚠️  Arabic overlay failed (${err.message}) — using original photo.`);
    }
    console.log('');
  } else if (args.post) {
    // TouchlineX-style posts always ship with a photo — refuse to publish one without it.
    throw new Error('No valid image found — post aborted. Retry with a different topic or try again later.');
  } else {
    console.log(`⚠️  No image — will be text-only post.\n`);
  }

  // 4. Post to Threads (or skip in dry-run)
  if (args.post) {
    if (!process.env.THREADS_ACCESS_TOKEN || !process.env.THREADS_USER_ID) {
      console.error(
        '❌ --post requested but THREADS_ACCESS_TOKEN / THREADS_USER_ID are not set.'
      );
      console.error('   Set them as environment variables or GitHub Secrets.');
      process.exit(1);
    }
    const { postId } = await postToThreads({ text, imageUrl: publishImageUrl });
    console.log(`\n✅ Posted successfully! Post id: ${postId}`);
  } else {
    console.log(`ℹ️  Dry run complete. Re-run with --post to publish to Threads.`);
  }
}

main().catch((err) => {
  console.error(`\n❌ Bot failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
