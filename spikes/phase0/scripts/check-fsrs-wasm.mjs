/**
 * Phase 0 Spike 0.5: Inspect ts-fsrs API + FSRS WASM optimizer packages on npm.
 * Run with: node spikes/phase0/scripts/check-fsrs-wasm.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tsFsrsPkg = require('../../../packages/core/node_modules/ts-fsrs/package.json');
const tsFsrs = await import('../../../packages/core/node_modules/ts-fsrs/dist/index.mjs');

const defaultParams = tsFsrs.generatorParameters({
  request_retention: 0.9,
  enable_fuzz: false,
  enable_short_term: true,
});

console.log('=== Spike 0.5: ts-fsrs & WASM Optimizer Audit ===\n');
console.log('Installed ts-fsrs:', {
  version: tsFsrsPkg.version,
  license: tsFsrsPkg.license,
  defaultWeightCount: defaultParams.w.length,
  fsrsVersionNote:
    defaultParams.w.length === 21
      ? 'FSRS-6 (21 weights)'
      : defaultParams.w.length === 19
        ? 'FSRS-5 (19 weights)'
        : `${defaultParams.w.length} weights`,
  enable_short_term: defaultParams.enable_short_term,
});

const candidates = [
  '@open-spaced-repetition/binding',
  'fsrs-rs-wasm',
  'fsrs-browser',
  'fsrs-wasm',
  'ts-fsrs',
];

console.log('\nChecking npm registry for FSRS WASM / optimizer packages:');
for (const name of candidates) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) {
      console.log(`- ${name}: NOT FOUND (HTTP ${res.status})`);
      continue;
    }
    const meta = await res.json();
    const latestTag = meta['dist-tags']?.latest;
    const latest = latestTag ? meta.versions?.[latestTag] : null;
    const fullRes = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(latestTag)}`,
    );
    const full = fullRes.ok ? await fullRes.json() : latest;
    console.log(`- ${name}@${latestTag}:`, {
      license: full?.license ?? 'unknown',
      unpackedKB: full?.dist?.unpackedSize ? Math.round(full.dist.unpackedSize / 1024) : 'unknown',
      description: full?.description ?? '',
      main: full?.main ?? null,
      module: full?.module ?? null,
      exports: full?.exports ? Object.keys(full.exports) : null,
      files: full?.files ?? null,
      deprecated: full?.deprecated ?? false,
    });
  } catch (err) {
    console.log(`- ${name}: ERROR (${err instanceof Error ? err.message : String(err)})`);
  }
}

// Verify deterministic replay with explicit 21-weight (FSRS-6) & 19-weight (FSRS-5) vectors
console.log('\nTesting ts-fsrs deterministic replay with custom weights:');
const scheduler = tsFsrs.fsrs(defaultParams);
const t0 = new Date('2026-01-01T00:00:00.000Z');
const card0 = tsFsrs.createEmptyCard(t0);
const r1a = scheduler.next(card0, t0, tsFsrs.Rating.Good).card;
const r1b = scheduler.next(card0, t0, tsFsrs.Rating.Good).card;
console.log('- Deterministic identical output:', r1a.due.getTime() === r1b.due.getTime());
console.log('- First Good review state:', {
  state: r1a.state,
  learning_steps: r1a.learning_steps,
  stability: Number(r1a.stability.toFixed(4)),
  difficulty: Number(r1a.difficulty.toFixed(4)),
  dueIso: r1a.due.toISOString(),
});
