import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const distDir = join(process.cwd(), 'apps', 'web', 'dist');
const fontExtensions = new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot']);
const foundFonts = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
    } else {
      const lower = entry.toLowerCase();
      for (const ext of fontExtensions) {
        if (lower.endsWith(ext)) {
          foundFonts.push(full);
        }
      }
    }
  }
}

walk(distDir);

if (foundFonts.length > 0) {
  console.error(
    'Performance budget violation (§8): default web fonts must be 0, found:',
    foundFonts,
  );
  process.exit(1);
}

// Verify TRUE total gzipped initial study-screen JS (every <script src> and <link rel="modulepreload" href> in dist/index.html)
const indexHtml = readFileSync(join(distDir, 'index.html'), 'utf8');
const initialJsUrls = new Set();
for (const match of indexHtml.matchAll(/<script[^>]+src="([^"]+\.js)"/g)) {
  if (match[1]) initialJsUrls.add(match[1]);
}
for (const match of indexHtml.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g)) {
  if (match[1]) initialJsUrls.add(match[1]);
}

let totalInitialGzipBytes = 0;
const breakdown = [];
for (const url of initialJsUrls) {
  const relPath = url.replace(/^\//, '');
  const fullPath = join(distDir, relPath);
  const raw = readFileSync(fullPath);
  const gz = gzipSync(raw, { level: 9 }).byteLength;
  totalInitialGzipBytes += gz;
  breakdown.push(`${relPath}: ${(gz / 1024).toFixed(2)} KB gz`);
}

const BUDGET_BYTES = 150 * 1024;
console.log('Initial study-screen JS breakdown:', breakdown.join(', '));
console.log(
  `Total initial study-screen JS: ${(totalInitialGzipBytes / 1024).toFixed(2)} KB gzipped (limit: 150.00 KB)`,
);

if (totalInitialGzipBytes > BUDGET_BYTES) {
  console.error(
    `Performance budget violation (§8): total initial JS (${totalInitialGzipBytes} B) exceeds 150 KB (${BUDGET_BYTES} B).`,
  );
  process.exit(1);
}

console.log('Font budget check passed: 0 web font files in apps/web/dist.');
