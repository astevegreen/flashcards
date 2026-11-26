/**
 * Pure TypeScript in-memory SQLite-table emulator for Node/Vitest tests (N9: test-only, never a
 * production fallback). It understands exactly the statements `CapacitorSqliteStorage` issues.
 */
import type { SqliteDriver, StoredEventDbRow } from '../../src/storage/sqlite-storage.ts';

/** A bound SQL parameter as text (strings as they are, anything else `String`-ed). */
function paramText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return fallback;
  return String(value as number | boolean | bigint);
}

export class InMemorySqliteDriver implements SqliteDriver {
  private events: StoredEventDbRow[] = [];
  private nextLocalSeq = 1;
  private cards = new Map<
    string,
    {
      id: string;
      deck_id: string;
      note_id: string;
      layout_id: string;
      due: number;
      schedule_json: string;
    }
  >();
  private media = new Map<string, { hash: string; mime: string; bytes_b64: string }>();
  private kv = new Map<string, string>();
  private backups = new Map<
    string,
    { backup_id: string; created_at: number; info_json: string; bytes_b64: string }
  >();
  private backupChunks = new Map<string, string>();
  /** `local_snapshot_chunks`, keyed by `${gen}\u0000${idx}`. */
  private snapshotChunks = new Map<string, string>();

  async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    const norm = sql.trim().replace(/\s+/g, ' ');
    if (norm.startsWith('CREATE TABLE') || norm.startsWith('CREATE INDEX')) return;
    if (norm.startsWith('DROP TABLE')) return;

    if (norm.startsWith('INSERT OR IGNORE INTO events')) {
      const id = String(params[0] ?? '');
      if (this.events.some((e) => e.id === id)) return;
      this.events.push({
        local_seq: this.nextLocalSeq++,
        id,
        device: String(params[1] ?? ''),
        seq: Number(params[2] ?? 0),
        hlc: String(params[3] ?? ''),
        type: String(params[4] ?? ''),
        v: Number(params[5] ?? 1),
        card_id: params[6] !== null && params[6] !== undefined ? String(params[6]) : null,
        payload_json: String(params[7] ?? 'null'),
        extra_fields_json: params[8] !== null && params[8] !== undefined ? String(params[8]) : null,
      });
      return;
    }
    if (norm.startsWith('DELETE FROM cards_cache WHERE id =')) {
      this.cards.delete(String(params[0] ?? ''));
      return;
    }
    if (norm.startsWith('DELETE FROM cards_cache')) {
      this.cards.clear();
      return;
    }
    if (norm.startsWith('INSERT OR REPLACE INTO cards_cache')) {
      const id = String(params[0] ?? '');
      this.cards.set(id, {
        id,
        deck_id: String(params[1] ?? ''),
        note_id: String(params[2] ?? ''),
        layout_id: String(params[3] ?? ''),
        due: Number(params[4] ?? 0),
        schedule_json: String(params[5] ?? '{}'),
      });
      return;
    }
    if (norm.startsWith('INSERT OR REPLACE INTO media')) {
      const hash = String(params[0] ?? '');
      this.media.set(hash, {
        hash,
        mime: String(params[1] ?? ''),
        bytes_b64: String(params[2] ?? ''),
      });
      return;
    }
    if (norm.startsWith('INSERT OR REPLACE INTO kv')) {
      this.kv.set(String(params[0] ?? ''), String(params[1] ?? 'null'));
      return;
    }
    if (norm.startsWith('INSERT OR REPLACE INTO backups')) {
      const backupId = paramText(params[0], '');
      this.backups.set(backupId, {
        backup_id: backupId,
        created_at: Number(params[1] ?? 0),
        info_json: paramText(params[2], 'null'),
        bytes_b64: paramText(params[3], ''),
      });
      return;
    }
    if (norm.startsWith('INSERT INTO backup_chunks')) {
      this.backupChunks.set(
        `${paramText(params[0], '')}#${paramText(params[1], '0')}`,
        paramText(params[2], ''),
      );
      return;
    }
    if (norm.startsWith('DELETE FROM backup_chunks WHERE backup_id NOT IN')) {
      for (const key of [...this.backupChunks.keys()]) {
        if (!this.backups.has(key.slice(0, key.lastIndexOf('#')))) this.backupChunks.delete(key);
      }
      return;
    }
    if (norm.startsWith('DELETE FROM backup_chunks WHERE backup_id =')) {
      const prefix = `${paramText(params[0], '')}#`;
      for (const key of [...this.backupChunks.keys()]) {
        if (key.startsWith(prefix)) this.backupChunks.delete(key);
      }
      return;
    }
    if (norm.startsWith('INSERT INTO local_snapshot_chunks')) {
      const key = `${paramText(params[0], '')}\u0000${Number(params[1] ?? 0)}`;
      if (this.snapshotChunks.has(key)) throw new Error('UNIQUE constraint failed');
      this.snapshotChunks.set(key, paramText(params[2], ''));
      return;
    }
    if (norm.startsWith('DELETE FROM local_snapshot_chunks')) {
      const gen = paramText(params[0], '');
      const keep = norm.endsWith('WHERE gen <> ?');
      const only = norm.endsWith('WHERE gen = ?');
      for (const key of [...this.snapshotChunks.keys()]) {
        const keyGen = key.slice(0, key.indexOf('\u0000'));
        if ((keep && keyGen === gen) || (only && keyGen !== gen)) continue;
        this.snapshotChunks.delete(key);
      }
      return;
    }
    if (norm.startsWith('DELETE FROM backups WHERE backup_id =')) {
      this.backups.delete(paramText(params[0], ''));
      return;
    }
    if (norm.startsWith('DELETE FROM kv WHERE key =')) {
      this.kv.delete(String(params[0] ?? ''));
      return;
    }
    if (norm.startsWith('DELETE FROM events')) {
      this.events = [];
      this.nextLocalSeq = 1;
      return;
    }
    if (norm.startsWith('DELETE FROM media WHERE hash =')) {
      this.media.delete(paramText(params[0], ''));
      return;
    }
    if (norm.startsWith('DELETE FROM media')) {
      this.media.clear();
      return;
    }
    if (norm.startsWith('DELETE FROM kv')) {
      this.kv.clear();
    }
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const norm = sql.trim().replace(/\s+/g, ' ');

    if (norm.startsWith('SELECT COALESCE(MAX(local_seq), 0) AS max_seq FROM events')) {
      const maxSeq =
        this.events.length > 0 ? (this.events[this.events.length - 1]?.local_seq ?? 0) : 0;
      return [{ max_seq: maxSeq } as T];
    }

    if (norm.includes('FROM events')) {
      let rows = [...this.events];
      let limit: number | undefined;
      if (norm.includes('WHERE hlc >= ? AND (hlc > ? OR id > ?)')) {
        const afterHlc = String(params[0] ?? '');
        const afterId = String(params[2] ?? '');
        rows = rows.filter((r) => r.hlc > afterHlc || (r.hlc === afterHlc && r.id > afterId));
        limit = Number(params[3]);
      } else if (norm.includes('WHERE card_id = ?')) {
        const cardId = String(params[0] ?? '');
        rows = rows.filter((r) => r.card_id === cardId);
      } else if (norm.includes('WHERE device = ? AND seq > ?')) {
        const dev = String(params[0] ?? '');
        const afterSeq = Number(params[1] ?? 0);
        rows = rows.filter((r) => r.device === dev && r.seq > afterSeq);
        rows.sort((a, b) => a.seq - b.seq);
        return rows as T[];
      } else if (norm.includes('WHERE local_seq > ?')) {
        const afterLocal = Number(params[0] ?? 0);
        rows = rows.filter((r) => r.local_seq > afterLocal);
        rows.sort((a, b) => a.local_seq - b.local_seq);
        return (norm.endsWith('LIMIT ?') ? rows.slice(0, Number(params[1])) : rows) as T[];
      }
      rows.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.id < b.id ? -1 : 1));
      return (limit === undefined ? rows : rows.slice(0, limit)) as T[];
    }

    if (norm.includes('FROM cards_cache')) {
      let rows = [...this.cards.values()];
      if (norm.includes('WHERE id > ? ORDER BY id ASC LIMIT ?')) {
        const afterId = String(params[0] ?? '');
        rows = rows.filter((r) => r.id > afterId).sort((a, b) => (a.id < b.id ? -1 : 1));
        rows = rows.slice(0, Number(params[1]));
      }
      return rows as T[];
    }
    if (norm.startsWith('SELECT chunk FROM local_snapshot_chunks WHERE gen = ? AND idx = ?')) {
      const raw = this.snapshotChunks.get(
        `${paramText(params[0], '')}\u0000${Number(params[1] ?? 0)}`,
      );
      return raw === undefined ? [] : ([{ chunk: raw }] as T[]);
    }
    if (norm.startsWith('SELECT hash, mime, bytes_b64 FROM media WHERE hash = ?')) {
      const row = this.media.get(String(params[0] ?? ''));
      return row ? ([row] as T[]) : [];
    }
    if (norm.startsWith('SELECT hash FROM media')) {
      return [...this.media.keys()].map((hash) => ({ hash }) as T);
    }
    if (norm.startsWith('SELECT info_json FROM backups')) {
      return [...this.backups.values()]
        .sort((a, b) => b.created_at - a.created_at)
        .map((r) => ({ info_json: r.info_json }) as T);
    }
    if (norm.startsWith('SELECT b64 FROM backup_chunks WHERE backup_id = ? AND idx = ?')) {
      const raw = this.backupChunks.get(`${paramText(params[0], '')}#${paramText(params[1], '0')}`);
      return raw !== undefined ? ([{ b64: raw }] as T[]) : [];
    }
    if (norm.startsWith('SELECT bytes_b64 FROM backups WHERE backup_id = ?')) {
      const row = this.backups.get(paramText(params[0], ''));
      return row ? ([{ bytes_b64: row.bytes_b64 }] as T[]) : [];
    }
    if (norm.startsWith('SELECT value_json FROM kv WHERE key = ?')) {
      const raw = this.kv.get(String(params[0] ?? ''));
      return raw !== undefined ? ([{ value_json: raw }] as T[]) : [];
    }
    return [];
  }
}
