import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveNoteId,
} from '../../../packages/core/src/index.ts';
import { importFlashpkg } from '../../../packages/core/src/import/flashpkg.ts';
import {
  encodeDeviceHead,
  encodeEventsSegment,
  encodeManifest,
  SYNC_V1_PREFIX,
} from '../../../packages/core/src/sync/index.ts';
import {
  buildFamilyCatalogJson,
  buildPackageFromDirectory,
  buildPackageFromSpec,
  enrichPackageWithAudio,
  handleMcpRequest,
  loadCollectionFromMirror,
  processInboxFolder,
  validateArtifactBytes,
  validateFile,
} from '../src/index.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('Phase 7 tools/cli & Local MCP Server (§7.1, §10.3)', () => {
  it('build + validate: compiles directory of CSV decks and Markdown pages with --ai provenance', () => {
    const workDir = makeTempDir('flash-cli-build-');
    writeFileSync(
      join(workDir, 'flashpkg.config.json'),
      JSON.stringify({
        package_id: 'pkg:korean-starter',
        name: 'Korean Starter',
        version: '1.2.0',
        author: 'AI Author',
        license: 'CC0-1.0',
        language: 'ko',
      }),
    );
    writeFileSync(
      join(workDir, 'greetings.csv'),
      'Word,Meaning,Tags\n안녕하세요,hello,basics\n감사합니다,thank you,basics\n',
    );
    writeFileSync(
      join(workDir, 'intro.md'),
      '---\nslug: intro-hangul\ntitle: Intro to Hangul\nlang: ko\ntags: [guide]\n---\n\n# Hangul\n\n::say[안녕하세요]{lang=ko}\n',
    );

    const outPkg = join(workDir, 'dist', 'korean-starter.flashpkg');
    const built = buildPackageFromDirectory(workDir, {
      outPath: outPkg,
      aiProvenance: true,
    });

    expect(built.packageId).toBe('pkg:korean-starter');
    expect(built.decksCount).toBe(1);
    expect(built.notesCount).toBe(2);
    expect(built.pagesCount).toBe(1);
    expect(existsSync(outPkg)).toBe(true);

    const validated = validateFile(outPkg);
    expect(validated.valid).toBe(true);
    expect(validated.kind).toBe('flashpkg');
    expect(validated.summary['notes']).toBe(2);
    expect(validated.summary['pages']).toBe(1);

    // Confirm AI provenance was stamped onto every note inside the archive
    const st = createEmptyState();
    const factory = createEventFactory('verify', 0, createHlcState('verify', 1000));
    const imported = importFlashpkg(readFileSync(outPkg), st, factory, { nowMs: 1000 });
    applyEvents(st, imported.events);
    for (const note of st.notes.values()) {
      expect(note.provenance).toEqual({ source: 'ai', reviewed: false });
    }

    // Validate catalog JSON & CSV & invalid input handling
    const catalogJson = buildFamilyCatalogJson({
      name: 'Family Catalog',
      packages: [
        {
          package_id: 'pkg:korean-starter',
          title: 'Korean Starter',
          description: 'Basics',
          url: 'https://packs.example.test/korean-starter.flashpkg',
          version: '1.2.0',
          languages: ['ko'],
        },
      ],
    });
    const catCheck = validateArtifactBytes('index.json', new TextEncoder().encode(catalogJson));
    expect(catCheck.valid).toBe(true);
    expect(catCheck.kind).toBe('family-catalog');

    const badZipCheck = validateArtifactBytes('broken.flashpkg', new Uint8Array([1, 2, 3]));
    expect(badZipCheck.valid).toBe(false);
  });

  it('audio: pre-generates 1.0x clips, content-hashes media/<sha256>.mp3, and attaches media:<sha256> to notes', async () => {
    const built = buildPackageFromSpec({
      packageId: 'pkg:audio-demo',
      name: 'Audio Demo',
      nowMs: 2000,
      decks: [
        {
          name: 'Korean Audio Deck',
          language: 'ko',
          notes: [
            { id: 'k1', fields: { word: '사랑', meaning: 'love' } },
            { id: 'k2', fields: { word: '사랑', meaning: 'affection (duplicate text)' } },
            { id: 'k3', fields: { word: '감사', meaning: 'gratitude' } },
          ],
        },
      ],
    });

    const enriched = await enrichPackageWithAudio(built.bytes, {
      provider: 'mock',
      nowMs: 3000,
    });

    // k1 & k2 share identical normalized text -> 2 unique syntheses + 1 reused clip
    expect(enriched.generatedCount).toBe(2);
    expect(enriched.reusedCount).toBe(1);
    expect(enriched.totalMediaCount).toBe(2);

    const st = createEmptyState();
    const factory = createEventFactory('verify', 0, createHlcState('verify', 3000));
    const imported = importFlashpkg(enriched.bytes, st, factory, { nowMs: 3000 });
    applyEvents(st, imported.events);

    expect(imported.extractedMedia.length).toBe(2);
    const notes = [...st.notes.values()];
    expect(notes.length).toBe(3);
    for (const n of notes) {
      expect(n.fields['audio']).toMatch(/^media:[0-9a-f]{64}$/);
    }
    const k1 = notes.find((n) => n.source_key === 'k1');
    const k2 = notes.find((n) => n.source_key === 'k2');
    expect(k1?.fields['audio']).toBe(k2?.fields['audio']);
  });

  it('inbox: scans Inbox/, imports .flashpkg + .csv + .md, and moves processed files to Inbox/imported/', () => {
    const inboxDir = makeTempDir('flash-inbox-');
    const pkg = buildPackageFromSpec({
      packageId: 'pkg:inbox-pkg',
      name: 'Inbox Pkg',
      decks: [
        {
          name: 'Hanja',
          language: 'ko',
          notes: [{ id: 'h1', fields: { word: '학교', meaning: 'school' } }],
        },
      ],
    });
    writeFileSync(join(inboxDir, 'sample.flashpkg'), pkg.bytes);
    writeFileSync(join(inboxDir, 'extra-ko.csv'), 'Word,Meaning\n우산,umbrella\n');
    writeFileSync(
      join(inboxDir, 'particles.md'),
      '---\ntitle: Particles\n---\n\nExplanation of 은/는.\n',
    );
    writeFileSync(join(inboxDir, 'invalid.flashpkg'), new Uint8Array([9, 8, 7]));

    const outConsolidated = join(inboxDir, 'imported', 'merged.flashpkg');
    const res = processInboxFolder(inboxDir, {
      outPackagePath: outConsolidated,
      aiProvenance: true,
      language: 'ko',
      nowMs: 5000,
    });

    expect(res.processed.sort()).toEqual(['extra-ko.csv', 'particles.md', 'sample.flashpkg']);
    expect(res.failed.length).toBe(1);
    expect(res.failed[0]?.file).toBe('invalid.flashpkg');

    expect(existsSync(join(inboxDir, 'sample.flashpkg'))).toBe(false);
    expect(existsSync(join(inboxDir, 'imported', 'sample.flashpkg'))).toBe(true);
    expect(existsSync(join(inboxDir, 'imported', 'extra-ko.csv'))).toBe(true);
    expect(existsSync(join(inboxDir, 'imported', 'particles.md'))).toBe(true);
    // Failed file stays in Inbox for manual inspection
    expect(existsSync(join(inboxDir, 'invalid.flashpkg'))).toBe(true);

    expect(res.state.decks.size).toBe(2);
    expect(res.state.notes.size).toBe(2);
    expect(res.state.pages.size).toBe(1);
    expect(existsSync(outConsolidated)).toBe(true);
  });

  it('mcp: reads sync/v1 mirror and exposes list_decks, get_weak_cards, get_stats, and propose_package', () => {
    const mirrorRoot = makeTempDir('flash-sync-mirror-');
    const inboxDir = makeTempDir('flash-mcp-inbox-');
    const syncV1 = join(mirrorRoot, SYNC_V1_PREFIX);
    const devDir = join(syncV1, 'devices', 'device-a');
    mkdirSync(devDir, { recursive: true });

    const factory = createEventFactory('device-a', 0, createHlcState('device-a', 1000));
    const deckId = 'deck-ko-1';
    const noteId1 = deriveNoteId(deckId, 'n1');
    const noteId2 = deriveNoteId(deckId, 'n2');
    const events = [
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: 'Korean Core',
          note_type_id: 'preset:vocab-ko',
          language: 'ko',
          created_at: 1000,
        },
        1000,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: noteId1,
          deck_id: deckId,
          source_key: 'n1',
          fields: { word: '경험', meaning: 'experience' },
          tags: ['vocab'],
          provenance: { source: 'user', reviewed: true },
          created_order: 0,
        },
        1001,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: noteId2,
          deck_id: deckId,
          source_key: 'n2',
          fields: { word: '약속', meaning: 'promise' },
          tags: ['vocab'],
          provenance: { source: 'ai', reviewed: false },
          created_order: 1,
        },
        1002,
      ),
    ];

    // Derive card IDs by applying events first, then append a lapsed ReviewRecorded
    const tmpState = createEmptyState();
    applyEvents(tmpState, events);
    const weakCard = [...tmpState.cards.values()].find((c) => c.note_id === noteId1);
    expect(weakCard).toBeDefined();
    if (weakCard) {
      events.push(
        factory.create(
          'ReviewRecorded',
          {
            review_id: 'rev-1',
            card_id: weakCard.id,
            rating: 1,
            reviewed_at: 2000,
            tz_offset: 0,
            duration_ms: 1500,
            answer_mode: 'flip',
            fsrs_params_version: 0,
            resulting_due_at: 2060,
          },
          2000,
        ),
      );
    }

    writeFileSync(
      join(syncV1, 'manifest.json'),
      encodeManifest({
        collection_id: 'col-1',
        format_version: 1,
        min_app_version: '0.1.0',
        created_at: 1000,
      }),
    );
    writeFileSync(join(devDir, 'seg-000001.jsonl.gz'), encodeEventsSegment(events));
    writeFileSync(
      join(devDir, 'head.json'),
      encodeDeviceHead({
        device_id: 'device-a',
        last_segment: 1,
        last_seq: events.length,
        updated_at: 2000,
      }),
    );

    const loadedState = loadCollectionFromMirror(mirrorRoot);
    expect(loadedState.decks.size).toBe(1);
    expect(loadedState.notes.size).toBe(2);

    const ctx = { mirrorPath: mirrorRoot, inboxDir, nowMs: () => 5000 };

    const initResp = handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, ctx);
    expect(initResp?.result).toBeTruthy();

    const listToolsResp = handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx);
    const toolNames = (listToolsResp?.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    );
    expect(toolNames).toEqual(['list_decks', 'get_weak_cards', 'get_stats', 'propose_package']);

    const decksResp = handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_decks', arguments: {} },
      },
      ctx,
    );
    const decksData = (
      decksResp?.result as {
        structuredContent: { decks: Array<{ name: string; needsReviewCount: number }> };
      }
    ).structuredContent;
    expect(decksData.decks[0]?.name).toBe('Korean Core');
    expect(decksData.decks[0]?.needsReviewCount).toBe(1);

    const weakResp = handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_weak_cards', arguments: { limit: 5 } },
      },
      ctx,
    );
    const weakData = (
      weakResp?.result as { structuredContent: { cards: Array<{ frontPreview: string }> } }
    ).structuredContent;
    expect(weakData.cards.length).toBe(1);
    expect(weakData.cards[0]?.frontPreview).toBe('경험');

    const statsResp = handleMcpRequest(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_stats', arguments: {} } },
      ctx,
    );
    const statsData = (
      statsResp?.result as {
        structuredContent: { totalNotes: number; totalReviews: number; needsReviewNotes: number };
      }
    ).structuredContent;
    expect(statsData.totalNotes).toBe(2);
    expect(statsData.totalReviews).toBe(1);
    expect(statsData.needsReviewNotes).toBe(1);

    const proposeResp = handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'propose_package',
          arguments: {
            name: 'AI Weak-Card Drill',
            language: 'ko',
            notes: [{ fields: { word: '경험하다', meaning: 'to experience' }, tags: ['ai-drill'] }],
          },
        },
      },
      ctx,
    );
    const proposeData = (
      proposeResp?.result as { structuredContent: { path: string; aiProvenance: boolean } }
    ).structuredContent;
    expect(proposeData.aiProvenance).toBe(true);
    expect(existsSync(proposeData.path)).toBe(true);
    expect(validateFile(proposeData.path).valid).toBe(true);
  });
});
