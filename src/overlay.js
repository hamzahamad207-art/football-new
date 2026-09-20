// Arabic text overlay for the post image.
//
// Requirement from the user: "if there's gonna be text on the images, it should
// be translated in arabic — the image should be redone so it has arabic text
// instead of english."
//
// Real photos can't have their baked-in English graphics pixel-translated
// without AI editing (which we deliberately never use). So we "redo" the image
// the TouchlineX way: keep the real photo and stamp the post's Arabic headline
// onto it with proper RTL Arabic shaping. We also steer the picker away from
// BBC video-banner pages whose images are english studio graphics (see
// content.js rankItem `/\/videos\//` penalty).
//
// Pipeline:
//   1. Download the picked real photo.
//   2. Build an SVG whose <style> embeds a real Arabic font (Tajawal, from
//      google/fonts) as a data: URI. librsvg shapes Arabic (ligatures, RTL)
//      through Pango, so a plain <text> element renders correctly.
//   3. Composite an Arabic-jp headline + dark gradient onto the photo with
//      sharp, output a JPEG.
//   4. pushComposedImage(): save it into the public repo's `out/` folder so
//      Threads can fetch it from a raw.githubusercontent.com URL (the Threads
//      API requires a publicly reachable image_url).

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileP = promisify(execFile);

// Static Arabic font files in the google/fonts repo. Tajawal-Black first,
// decent fallbacks after. TTF ~100-200 KB.
const FONT_URLS = [
  'https://raw.githubusercontent.com/google/fonts/main/ofl/tajawal/Tajawal-Black.ttf',
  'https://raw.githubusercontent.com/google/fonts/main/ofl/tajawal/Tajawal-ExtraBold.ttf',
  'https://raw.githubusercontent.com/google/fonts/main/ofl/tajawal/Tajawal-Bold.ttf',
];

let fontPathPromise = null;

/** Download the Arabic font once per process/job; null if unavailable. */
export function ensureArabicFont() {
  if (!fontPathPromise) {
    fontPathPromise = (async () => {
      const target = path.join(os.tmpdir(), 'touchline-tajawal-black.ttf');
      try {
        const st = await fs.stat(target);
        if (st.size > 20000) return target;
      } catch {
        /* not cached yet */
      }
      for (const url of FONT_URLS) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          await fs.writeFile(target, buf);
          return target;
        } catch {
          /* try next */
        }
      }
      return null;
    })();
  }
  return fontPathPromise;
}

/**
 * Reduce a post's text to a clean, Arabic-only single line for the image.
 * Drops emoji (no color-emoji font in librsvg), leading Latin headline
 * labels (FT/LIVE/HT/…), and returns '' if anything Latin remains — we never
 * render English text on the image.
 */
export function prepOverlayText(text) {
  let t = String(text || '').replace(/\r/g, '');
  t = t.split('\n')[0] || '';
  t = t
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{2764}\u{2B50}\u{26BD}\u{2B55}\u{3030}\u{25A0}-\u{25FE}]/gu,
      ''
    )
    // No quote marks on the image header — the model sometimes leaves a stray
    // unmatched quote, and quotes aren't wanted in a big display headline anyway.
    .replace(/["“”'‘’]/g, '')
    .replace(/^[\s:·•|,-]+/u, '')
    .trim();
  // Allow typed score/status headers like "FT: 3 - 1" but keep only arabic text.
  t = t.replace(/^(FT|LIVE|HT|ET|BREAKING|CLOSE|FINAL)\s*:\s*/i, '').trim();
  if (!t || /[A-Za-z]/.test(t)) return '';
  return t.replace(/\s+/g, ' ').trim();
}

/** Wrap text into lines that fit image width (approx char width ≈ 0.53×fontSize). */
function wrapLines(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (let w of words) {
    while (w.length > maxChars) {
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      lines.push(w.slice(0, maxChars));
      w = w.slice(maxChars);
    }
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  if (!lines.length) lines.push('');
  return lines;
}

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Download the image and stamp the Arabic header line onto it.
 * Returns { file, width, height, lines } or null when it can't be done safely.
 */
export async function applyArabicOverlay(imageUrl, text) {
  if (!imageUrl || !/^https:\/\//i.test(imageUrl)) return null;
  const fontFile = await ensureArabicFont();
  const safeText = prepOverlayText(text);
  if (!fontFile || !safeText) return null;

  // 1) Download the real photo.
  const srcPath = path.join(os.tmpdir(), `tl-src-${Date.now()}.bin`);
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) return null;
  const srcBuf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(srcPath, srcBuf);

  // 2) Geometry + line wrapping.
  const meta = await sharp(srcBuf).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (!w || !h) return null;
  const fontSize = Math.max(34, Math.min(104, Math.round(Math.min(w, h * 1.3) * 0.055)));
  const maxChars = Math.max(8, Math.floor((w * 0.9) / (fontSize * 0.53)));
  const lines = wrapLines(safeText, maxChars).slice(0, 3);
  const lineHeight = Math.round(fontSize * 1.42);
  const blockPad = Math.round(fontSize * 0.7);
  const blockH = Math.min(
    Math.round(lines.length * lineHeight + blockPad * 2),
    Math.round(h * 0.45)
  );

  // 3) SVG with the font embedded (librsvg shapes Arabic via Pango).
  const fontData = (await fs.readFile(fontFile)).toString('base64');
  const textY0 = h - blockH + blockPad + lineHeight;
  const textEls = lines
    .map(
      (ln, i) =>
        `<text x="${w / 2}" y="${Math.round(textY0 + i * lineHeight)}" ` +
        `text-anchor="middle" font-family="Tajawal" font-size="${fontSize}" ` +
        `fill="#ffffff">${escapeXml(ln)}</text>`
    )
    .join('\n');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <style>
    @font-face { font-family:'Tajawal'; src:url(data:font/ttf;base64,${fontData}) format('truetype'); }
  </style>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="${Math.max(50, 100 - Math.round((blockH / h) * 100))}%" stop-color="#000000" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.72"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  ${textEls}
</svg>`;

  // 4) Compose and save as JPEG.
  const outPath = path.join(os.tmpdir(), `tl-ar-${Date.now()}.jpg`);
  await sharp(srcBuf)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 82, mozjpeg: false })
    .toFile(outPath);

  return { file: outPath, width: w, height: h, lines: lines.length, text: safeText };
}

/**
 * Host the composed image in this public repo (out/ folder) and return a
 * publicly-fetchable URL for Threads. Uses git push — works both on the
 * GitHub Actions runner (GITHUB_TOKEN) and locally (cached credentials).
 *
 * Runs push to this same repo one after another (concurrency group), so the
 * remote `main` can advance between our checkout and our push. We therefore
 * rebase onto origin/main before each push attempt and retry up to 4 times.
 */
export async function pushComposedImage(file) {
  const repoSlug = process.env.GITHUB_REPOSITORY || 'hamzahamad207-art/football-new';
  const [owner, repo] = repoSlug.split('/');
  const name = `tl-${Date.now()}.jpg`;
  const repoRoot = process.cwd();
  const outDir = path.join(repoRoot, 'out');

  await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(file, path.join(outDir, name));

  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const git = (cmd) =>
    execFileP('git', cmd, { cwd: repoRoot, env, timeout: 120000 }).catch((e) => {
      e.gitErr = String(e?.stderr || e?.message || e);
      throw e;
    });

  for (let attempt = 1; attempt <= 4; attempt++) {
    // Make sure the image is committed (well no-op after the first attempt).
    try {
      await git(['add', `out/${name}`]);
      await git([
        '-c', 'user.name=Touchline AR Bot',
        '-c', 'user.email=touchline-ar-bot@users.noreply.github.com',
        'commit',
        '-m', `📸 Post image ${name}`,
        '--no-verify',
      ]);
    } catch {
      /* nothing new to commit — proceed to push */
    }
    // Fold in whatever the previous run pushed so our push isn't rejected.
    try {
      await git(['pull', '--rebase', 'origin', 'main']);
    } catch (e) {
      console.warn(`   rebase note: ${String(e?.gitErr || e).slice(0, 140)}`);
    }
    try {
      const r = await git(['push', 'origin', 'HEAD:main']);
      if (!String(r?.stderr || '').includes('Everything up-to-date')) {
        console.log(`   git push → ${name}`);
      }
      return `https://raw.githubusercontent.com/${owner}/${repo}/main/out/${name}?v=${Date.now()}`;
    } catch (e) {
      console.warn(`   push attempt ${attempt} failed: ${String(e?.gitErr || e).slice(0, 140)}`);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  console.warn('⚠️  Could not push composed image after retries — posting original photo instead.');
  return null;
}