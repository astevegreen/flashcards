#!/usr/bin/env node
/**
 * Writes the published JSON Schemas for package and catalog formats to
 * `docs/formats/schemas/*.schema.json`, generated from the Zod source of truth in
 * `packages/content-schema` (§3.4, §12.2 "formats remain documented").
 *
 *   node scripts/export-schemas.mjs
 *
 * Requires Node 24+ (runs the TypeScript schema package directly via type stripping).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { getPackageJsonSchemas } from '../packages/content-schema/src/index.ts';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'formats', 'schemas');
mkdirSync(outDir, { recursive: true });

const schemas = getPackageJsonSchemas();
for (const [name, schema] of Object.entries(schemas)) {
  const file = join(outDir, `${name}.schema.json`);
  // Format with the repo's Prettier config so `pnpm format:check` stays clean after regenerating.
  const options = { ...(await resolveConfig(file)), filepath: file };
  writeFileSync(file, await format(JSON.stringify(schema), options), 'utf8');
}
console.log(`Wrote ${Object.keys(schemas).length} schemas to ${outDir}`);
