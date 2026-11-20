/**
 * Phase 0 Spikes 0.6 & 0.7a:
 * - Verifies CORS headers for GitHub raw & jsDelivr (.flashpkg / data URLs).
 * - Audits npm packages & licenses for Hanzi Writer, Make Me a Hanzi, KanjiVG, dictionaries.
 * - Fetches real KanjiVG SVG files (食 U+98DF, 語 U+8A9E), converts their Japanese stroke order
 *   into Hanzi Writer CharacterJson format, and writes JSON fixtures for spikes/phase0/drawing.html.
 *
 * Run with: node spikes/phase0/scripts/check-cors-and-licenses.mjs
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ORIGIN = 'https://flashcards-spike.pages.dev';

console.log('=== Spike 0.7a: CORS Header Checks ===\n');
const corsTargets = [
  {
    label: 'GitHub Raw (public repo)',
    url: 'https://raw.githubusercontent.com/open-spaced-repetition/ts-fsrs/main/package.json',
  },
  {
    label: 'GitHub Raw (KanjiVG SVG)',
    url: 'https://raw.githubusercontent.com/KanjiVG/kanjivg/master/kanji/098df.svg',
  },
  {
    label: 'jsDelivr (hanzi-writer-data)',
    url: 'https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0.1/%E9%A3%9F.json',
  },
  {
    label: 'Google Cloud TTS REST (OPTIONS preflight)',
    url: 'https://texttospeech.googleapis.com/v1/text:synthesize',
    method: 'OPTIONS',
    extraHeaders: {
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  },
];

for (const target of corsTargets) {
  try {
    const res = await fetch(target.url, {
      method: target.method ?? 'HEAD',
      headers: {
        Origin: TEST_ORIGIN,
        ...(target.extraHeaders ?? {}),
      },
    });
    console.log(`- ${target.label}: HTTP ${res.status}`, {
      'access-control-allow-origin': res.headers.get('access-control-allow-origin'),
      'access-control-allow-methods': res.headers.get('access-control-allow-methods'),
      'access-control-allow-headers': res.headers.get('access-control-allow-headers'),
      vary: res.headers.get('vary'),
      'content-type': res.headers.get('content-type'),
    });
  } catch (err) {
    console.log(`- ${target.label}: ERROR (${err instanceof Error ? err.message : String(err)})`);
  }
}

console.log('\n=== Spike 0.6: Stroke & Dictionary Package License Check ===\n');
for (const pkg of ['hanzi-writer', 'hanzi-writer-data', 'hanzi-writer-data-jp']) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`);
  if (!res.ok) {
    console.log(`- ${pkg}: HTTP ${res.status}`);
    continue;
  }
  const data = await res.json();
  console.log(`- ${pkg}@${data.version}:`, {
    license: data.license,
    unpackedKB: data.dist?.unpackedSize ? Math.round(data.dist.unpackedSize / 1024) : 'unknown',
    repository:
      typeof data.repository === 'string' ? data.repository : (data.repository?.url ?? null),
    description: data.description,
  });
}

/**
 * Minimal KanjiVG (109x109 top-down) -> Hanzi Writer (1024x1024 flipped Y=900) converter
 * for Spike 0.6 PoC. Extracts stroke centerline paths (`d="..."`), samples approximate medians
 * and generates a stroked outline ribbon so Hanzi Writer can render & quiz Japanese stroke order.
 */
function sampleSvgPathPoints(d) {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const pts = [];
  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;

  const num = () => Number(tokens[i++]);
  const push = (x, y) => pts.push([x, y]);

  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) {
      cmd = tokens[i++];
    }
    switch (cmd) {
      case 'M': {
        cx = num();
        cy = num();
        push(cx, cy);
        cmd = 'L';
        break;
      }
      case 'm': {
        cx += num();
        cy += num();
        push(cx, cy);
        cmd = 'l';
        break;
      }
      case 'L': {
        cx = num();
        cy = num();
        push(cx, cy);
        break;
      }
      case 'l': {
        cx += num();
        cy += num();
        push(cx, cy);
        break;
      }
      case 'H': {
        cx = num();
        push(cx, cy);
        break;
      }
      case 'h': {
        cx += num();
        push(cx, cy);
        break;
      }
      case 'V': {
        cy = num();
        push(cx, cy);
        break;
      }
      case 'v': {
        cy += num();
        push(cx, cy);
        break;
      }
      case 'C': {
        const x1 = num();
        const y1 = num();
        const x2 = num();
        const y2 = num();
        const x3 = num();
        const y3 = num();
        for (const t of [0.25, 0.5, 0.75, 1]) {
          const mt = 1 - t;
          const x = mt ** 3 * cx + 3 * mt ** 2 * t * x1 + 3 * mt * t ** 2 * x2 + t ** 3 * x3;
          const y = mt ** 3 * cy + 3 * mt ** 2 * t * y1 + 3 * mt * t ** 2 * y2 + t ** 3 * y3;
          push(x, y);
        }
        cx = x3;
        cy = y3;
        break;
      }
      case 'c': {
        const x1 = cx + num();
        const y1 = cy + num();
        const x2 = cx + num();
        const y2 = cy + num();
        const x3 = cx + num();
        const y3 = cy + num();
        for (const t of [0.25, 0.5, 0.75, 1]) {
          const mt = 1 - t;
          const x = mt ** 3 * cx + 3 * mt ** 2 * t * x1 + 3 * mt * t ** 2 * x2 + t ** 3 * x3;
          const y = mt ** 3 * cy + 3 * mt ** 2 * t * y1 + 3 * mt * t ** 2 * y2 + t ** 3 * y3;
          push(x, y);
        }
        cx = x3;
        cy = y3;
        break;
      }
      case 'S':
      case 's': {
        const isRel = cmd === 's';
        const x2 = (isRel ? cx : 0) + num();
        const y2 = (isRel ? cy : 0) + num();
        const x3 = (isRel ? cx : 0) + num();
        const y3 = (isRel ? cy : 0) + num();
        push((cx + x2 + x3) / 3, (cy + y2 + y3) / 3);
        push(x3, y3);
        cx = x3;
        cy = y3;
        break;
      }
      default: {
        i++;
        break;
      }
    }
  }
  return pts;
}

function buildRibbonPath(points, halfWidth = 28) {
  if (points.length < 2) return '';
  const left = [];
  const right = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * halfWidth;
    const ny = (dx / len) * halfWidth;
    left.push([Math.round(points[i][0] + nx), Math.round(points[i][1] + ny)]);
    right.push([Math.round(points[i][0] - nx), Math.round(points[i][1] - ny)]);
  }
  const ring = [...left, ...right.reverse()];
  return `M ${ring[0][0]} ${ring[0][1]} ${ring
    .slice(1)
    .map(([x, y]) => `L ${x} ${y}`)
    .join(' ')} Z`;
}

function convertKanjivgSvgToHanziWriter(svgText) {
  const pathMatches = [...svgText.matchAll(/<path[^>]*\bd="([^"]+)"/g)];
  const scale = 1024 / 109;
  const strokes = [];
  const medians = [];
  for (const m of pathMatches) {
    const rawPts = sampleSvgPathPoints(m[1]);
    if (rawPts.length < 2) continue;
    const hwPts = rawPts.map(([x, y]) => [Math.round(x * scale), Math.round(900 - y * scale)]);
    medians.push(hwPts);
    strokes.push(buildRibbonPath(hwPts, 24));
  }
  return { strokes, medians };
}

console.log('\n=== Spike 0.6: KanjiVG -> Hanzi Writer PoC Conversion ===\n');
for (const item of [
  { char: '食', code: '098df' },
  { char: '語', code: '08a9e' },
]) {
  const svgUrl = `https://raw.githubusercontent.com/KanjiVG/kanjivg/master/kanji/${item.code}.svg`;
  const res = await fetch(svgUrl);
  if (!res.ok) {
    console.log(`- ${item.char} (${item.code}): failed HTTP ${res.status}`);
    continue;
  }
  const svgText = await res.text();
  const converted = convertKanjivgSvgToHanziWriter(svgText);
  const outPath = join(__dirname, '..', `kanjivg-${item.code}.json`);
  await writeFile(outPath, JSON.stringify(converted), 'utf8');
  console.log(
    `- Converted ${item.char} (KanjiVG ${item.code}.svg): ${converted.strokes.length} Japanese strokes -> kanjivg-${item.code}.json (${JSON.stringify(converted).length} bytes)`,
  );
}
