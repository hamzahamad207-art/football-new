// Main orchestrator — picks a content type, fetches news context, generates
// Khaleeji Arabic text, fetches a matching image, posts to Threads.
//
// Usage:
//   node src/index.js                                  # random type, dry-run
//   node src/index.js --type news                      # specific type
//   node src/index.js --type news --topic "Barça vs Sevilla"
//   node src/index.js --post                           # actually post
//   BOT_TOPIC="Barça vs Sevilla" node src/index.js -t analysis --post

import { CONTENT_TYPES, pickRandom, TEMPLATES } from './templates.js';
import { fetchNewsContext, generatePostText } from './content.js';
import { pickImageForContent } from './images.js';
import { postToThreads } from './threads.js';

function parseArgs(argv) {
  const args = { type: 'random', topic: '', post: false, dryRun: true, listTypes: false };
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
  --help, -h            Show this help

Environment variables:
  THREADS_ACCESS_TOKEN  Threads long-lived access token (required with --post)
  THREADS_USER_ID       Threads user id (numeric, required with --post)
  BOT_TOPIC             Same as --topic (used by the GitHub Actions workflow)

Examples:
  node src/index.js --dry-run                                      # preview random post
  node src/index.js -t news --topic "Barça vs Sevilla" --dry-run   # preview a focused post
  node src/index.js -t analysis -m "محمد صلاح" --post               # post tactical analysis
  BOT_TOPIC="Al-Hilal vs Al-Nassr" node src/index.js -t news --post # env-var flavor
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.listTypes) {
    printHelp();
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

  // 1. Fetch news / context (pass topic override if provided)
  const ctx = await fetchNewsContext(type, { topicOverride: args.topic });
  console.log(`📋 Topic: ${ctx.topic}`);
  if (ctx.summary) console.log(`   Summary: ${ctx.summary.slice(0, 100)}...`);

  // 2. Generate Arabic post text via LLM
  const text = await generatePostText(type, ctx);
  console.log(`\n📝 Post text (${text.length} chars):\n${text}\n`);

  // 3. Fetch image
  const { imageUrl } = await pickImageForContent(type, ctx);
  if (imageUrl) {
    console.log(`🖼️  Image URL: ${imageUrl}\n`);
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
    const { postId } = await postToThreads({ text, imageUrl });
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
