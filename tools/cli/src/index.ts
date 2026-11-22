import { resolve } from 'node:path';
import * as process from 'node:process';
import { runAudioFileEnrichment, type AudioProviderKind } from './commands/audio.ts';
import { buildPackageFromDirectory } from './commands/build.ts';
import { processInboxFolder } from './commands/inbox.ts';
import { validateFile } from './commands/validate.ts';
import { runMcpStdioServer } from './mcp.ts';

export * from './commands/audio.ts';
export * from './commands/build.ts';
export * from './commands/inbox.ts';
export * from './commands/validate.ts';
export * from './mcp.ts';

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok) continue;
    if (tok.startsWith('--')) {
      const eqIdx = tok.indexOf('=');
      if (eqIdx > 2) {
        flags[tok.slice(2, eqIdx)] = tok.slice(eqIdx + 1);
      } else {
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else if (tok === '-o' && argv[i + 1]) {
      flags['out'] = argv[i + 1] ?? '';
      i += 1;
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags };
}

function flagString(
  flags: Record<string, string | boolean>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const val = flags[k];
    if (typeof val === 'string' && val.trim().length > 0) return val.trim();
  }
  return undefined;
}

function usageText(): string {
  return [
    'Usage: flash-cli <command> [args]',
    '',
    'Commands:',
    '  validate <file> [--allow-relative]',
    '  build <input-dir> [-o <out.flashpkg>] [--name <name>] [--lang <lang>] [--ai]',
    '  audio <input.flashpkg> --provider <google|azure|mock> [--key <key>] [--region <region>] [-o <out.flashpkg>]',
    '  inbox <inbox-dir> [-o <out.flashpkg>] [--lang <lang>] [--ai]',
    '  mcp [--mirror <sync-dir-or-flashpkg>] [--inbox <inbox-dir>]',
  ].join('\n');
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(usageText() + '\n');
    return 0;
  }

  const { positional, flags } = parseArgs(rest);

  if (cmd === 'validate') {
    const target = positional[0];
    if (!target) {
      process.stderr.write('validate requires a file path.\n');
      return 2;
    }
    const res = validateFile(resolve(target), {
      allowRelativePackUrls: Boolean(flags['allow-relative']),
    });
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return res.valid ? 0 : 1;
  }

  if (cmd === 'build') {
    const inputDir = positional[0];
    if (!inputDir) {
      process.stderr.write('build requires an input directory.\n');
      return 2;
    }
    const outPath = flagString(flags, 'out');
    const name = flagString(flags, 'name');
    const version = flagString(flags, 'version');
    const language = flagString(flags, 'lang', 'language');
    const res = buildPackageFromDirectory(resolve(inputDir), {
      ...(outPath ? { outPath: resolve(outPath) } : {}),
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
      ...(language ? { language } : {}),
      aiProvenance: Boolean(flags['ai']),
    });
    process.stdout.write(
      JSON.stringify(
        {
          packageId: res.packageId,
          outPath: res.outPath,
          decksCount: res.decksCount,
          notesCount: res.notesCount,
          pagesCount: res.pagesCount,
          mediaCount: res.mediaCount,
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }

  if (cmd === 'audio') {
    const inFile = positional[0];
    if (!inFile) {
      process.stderr.write('audio requires an input .flashpkg file path.\n');
      return 2;
    }
    const providerRaw = flagString(flags, 'provider') ?? 'google';
    if (providerRaw !== 'google' && providerRaw !== 'azure' && providerRaw !== 'mock') {
      process.stderr.write(`Unsupported audio provider "${providerRaw}".\n`);
      return 2;
    }
    const provider: AudioProviderKind = providerRaw;
    const outPath = flagString(flags, 'out') ?? inFile;
    const apiKey = flagString(flags, 'key');
    const azureRegion = flagString(flags, 'region');
    const res = await runAudioFileEnrichment(resolve(inFile), resolve(outPath), {
      provider,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(azureRegion !== undefined ? { azureRegion } : {}),
      overwriteExisting: Boolean(flags['overwrite']),
    });
    process.stdout.write(
      JSON.stringify(
        {
          outPath: res.outPath,
          generatedCount: res.generatedCount,
          reusedCount: res.reusedCount,
          skippedCount: res.skippedCount,
          totalMediaCount: res.totalMediaCount,
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }

  if (cmd === 'inbox') {
    const inboxDir = positional[0];
    if (!inboxDir) {
      process.stderr.write('inbox requires a directory path.\n');
      return 2;
    }
    const outPackagePath = flagString(flags, 'out');
    const language = flagString(flags, 'lang', 'language');
    const res = processInboxFolder(resolve(inboxDir), {
      ...(outPackagePath ? { outPackagePath: resolve(outPackagePath) } : {}),
      ...(language ? { language } : {}),
      aiProvenance: Boolean(flags['ai']),
    });
    process.stdout.write(
      JSON.stringify(
        {
          processed: res.processed,
          failed: res.failed,
          eventsEmitted: res.events.length,
          ...(res.outPackagePath ? { outPackagePath: res.outPackagePath } : {}),
        },
        null,
        2,
      ) + '\n',
    );
    return res.failed.length > 0 ? 1 : 0;
  }

  if (cmd === 'mcp') {
    const mirrorPath = flagString(flags, 'mirror');
    const inboxDir = flagString(flags, 'inbox');
    await runMcpStdioServer({
      ...(mirrorPath ? { mirrorPath: resolve(mirrorPath) } : {}),
      ...(inboxDir ? { inboxDir: resolve(inboxDir) } : {}),
    });
    return 0;
  }

  process.stderr.write(`Unknown command "${cmd}".\n${usageText()}\n`);
  return 2;
}
