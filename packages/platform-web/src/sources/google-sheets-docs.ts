import { SyncTransportError } from '@flash/core';
import { columnIndexToA1 } from '@flash/core/sources';
import type {
  Auth,
  GoogleDriveFileInfo,
  GoogleDriveFileMeta,
  GoogleSheetGrid,
  GoogleSourcesClient,
  PickedFile,
} from '@flash/platform';
import { readTextCapped } from '../net/read-capped.ts';
import { downloadDriveFileBytes, fetchDriveFileInfo } from './google-drive-files.ts';
import { createGoogleFetch, type GoogleFetch } from '../sync/google-http.ts';

const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const MAX_DOC_MARKDOWN_BYTES = 10 * 1024 * 1024; // 10 MB

export const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

export interface GoogleSourcesClientOptions {
  auth: Auth;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

function quoteSheetTab(sheetTitle: string): string {
  return `'${sheetTitle.replace(/'/g, "''")}'`;
}

function cellToString(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return '';
}

interface SpreadsheetMetaResponse {
  spreadsheetId?: string;
  properties?: { title?: string };
  sheets?: Array<{
    properties?: { title?: string };
  }>;
}

interface SpreadsheetValuesResponse {
  values?: unknown[][];
}

interface EmbeddedImageGridResponse {
  sheets?: Array<{
    data?: Array<{
      rowData?: Array<{
        values?: Array<{
          userEnteredValue?: Record<string, unknown>;
          effectiveValue?: Record<string, unknown>;
          formattedValue?: string;
        }>;
      }>;
    }>;
  }>;
}

/**
 * Lazy-loaded Google Sheets & Google Docs API client over `drive.file` (§3.1).
 * Uses cheap Drive `modifiedTime` checks, `valueRenderOption=FORMULA`,
 * single `values:batchUpdate` Card ID write-back, and Docs `text/markdown` export.
 */
export class WebGoogleSourcesClient implements GoogleSourcesClient {
  private readonly authorizedFetch: GoogleFetch;

  constructor(options: GoogleSourcesClientOptions) {
    this.authorizedFetch = createGoogleFetch({
      ...options,
      label: 'Google API',
      messages: {
        authRequired: 'Google session expired. Please reconnect Google in Settings or Library.',
        permissionDenied:
          'Permission denied accessing Google Sheet/Doc (it may be read-only or revoked).',
        notFound: 'Google Drive file was not found.',
      },
    });
  }

  async getFileMetadata(fileId: string): Promise<GoogleDriveFileMeta> {
    const params = new URLSearchParams({
      fields: 'id,name,mimeType,modifiedTime,capabilities(canEdit)',
    });
    const res = await this.authorizedFetch(
      `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}?${params.toString()}`,
    );
    if (!res.ok) {
      throw new SyncTransportError(
        'UNKNOWN',
        `Failed to fetch Drive metadata for "${fileId}" (HTTP ${res.status}).`,
        res.status,
      );
    }
    const data = (await res.json()) as {
      id?: string;
      name?: string;
      mimeType?: string;
      modifiedTime?: string;
      capabilities?: { canEdit?: boolean };
    };
    return {
      id: data.id ?? fileId,
      name: data.name ?? fileId,
      mimeType: data.mimeType ?? GOOGLE_SHEET_MIME,
      ...(data.modifiedTime !== undefined ? { modifiedTime: data.modifiedTime } : {}),
      canEdit: data.capabilities?.canEdit !== false,
    };
  }

  async readSheet(fileId: string, sheetTab?: string): Promise<GoogleSheetGrid> {
    const [meta, sheetInfoRes] = await Promise.all([
      this.getFileMetadata(fileId),
      this.authorizedFetch(
        `${SHEETS_API}/${encodeURIComponent(fileId)}?fields=spreadsheetId,properties.title,sheets.properties.title`,
      ),
    ]);

    if (!sheetInfoRes.ok) {
      throw new SyncTransportError(
        'UNKNOWN',
        `Failed to read Google Sheet metadata (HTTP ${sheetInfoRes.status}).`,
        sheetInfoRes.status,
      );
    }
    const sheetInfo = (await sheetInfoRes.json()) as SpreadsheetMetaResponse;
    const availableTabs = (sheetInfo.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => Boolean(t));
    const targetTab =
      sheetTab && availableTabs.includes(sheetTab) ? sheetTab : (availableTabs[0] ?? 'Sheet1');

    const range = `${quoteSheetTab(targetTab)}!A1:ZZ`;
    const valuesRes = await this.authorizedFetch(
      `${SHEETS_API}/${encodeURIComponent(fileId)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMULA`,
    );
    if (!valuesRes.ok) {
      throw new SyncTransportError(
        'UNKNOWN',
        `Failed to read Google Sheet values (HTTP ${valuesRes.status}).`,
        valuesRes.status,
      );
    }
    const valuesData = (await valuesRes.json()) as SpreadsheetValuesResponse;
    const values: string[][] = (valuesData.values ?? []).map((row) => row.map(cellToString));

    // Optional lightweight check for unsupported embedded in-cell images when an Image/Picture column exists
    const embeddedImageRows = await this.detectEmbeddedImageRows(fileId, targetTab, values);

    return {
      spreadsheetId: sheetInfo.spreadsheetId ?? fileId,
      title: sheetInfo.properties?.title ?? meta.name,
      sheetTitle: targetTab,
      ...(meta.modifiedTime !== undefined ? { modifiedTime: meta.modifiedTime } : {}),
      values,
      readOnly: !meta.canEdit,
      embeddedImageRows,
    };
  }

  private async detectEmbeddedImageRows(
    fileId: string,
    sheetTitle: string,
    values: readonly (readonly string[])[],
  ): Promise<number[]> {
    const headers = values[0];
    if (!headers || values.length <= 1) return [];
    const imageColIdx = headers.findIndex((h) => {
      const norm = h.trim().toLowerCase();
      return norm === 'image' || /^picture\s*1?$/.test(norm);
    });
    if (imageColIdx < 0) return [];

    // Check only the single Image column for rows that came back empty in values.get
    const colLetter = columnIndexToA1(imageColIdx);
    const maxRow = values.length;
    const colRange = `${quoteSheetTab(sheetTitle)}!${colLetter}2:${colLetter}${maxRow}`;
    try {
      const params = new URLSearchParams({
        ranges: colRange,
        includeGridData: 'true',
        fields: 'sheets.data.rowData.values(userEnteredValue,effectiveValue,formattedValue)',
      });
      const res = await this.authorizedFetch(
        `${SHEETS_API}/${encodeURIComponent(fileId)}?${params.toString()}`,
      );
      if (!res.ok) return [];
      const data = (await res.json()) as EmbeddedImageGridResponse;
      const rows = data.sheets?.[0]?.data?.[0]?.rowData ?? [];
      const flagged: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        const cell = rows[i]?.values?.[0];
        if (!cell) continue;
        const rowNum = i + 2;
        const rawVal = (values[rowNum - 1]?.[imageColIdx] ?? '').trim();
        // Embedded in-cell images in Sheets API often appear with an error/image value or formattedValue
        // while lacking a stringValue / formulaValue
        const uev = cell.userEnteredValue;
        const ev = cell.effectiveValue;
        const hasFormula = typeof uev?.['formulaValue'] === 'string';
        const hasStr = typeof uev?.['stringValue'] === 'string';
        const hasError = ev?.['errorValue'] !== undefined;
        const hasImageMarker =
          cell.formattedValue === '[Image]' ||
          (uev !== undefined && !hasFormula && !hasStr && Object.keys(uev).length > 0);
        if (!rawVal && (hasImageMarker || hasError)) {
          flagged.push(rowNum);
        }
      }
      return flagged;
    } catch {
      // Non-fatal: embedded image inspection is best-effort
      return [];
    }
  }

  async writeSheetCells(
    fileId: string,
    sheetTitle: string,
    updates: ReadonlyArray<{ a1: string; value: string }>,
  ): Promise<void> {
    if (updates.length === 0) return;
    const quotedTab = quoteSheetTab(sheetTitle);
    const body = {
      valueInputOption: 'RAW',
      data: updates.map((u) => ({
        range: `${quotedTab}!${u.a1}`,
        values: [[u.value]],
      })),
    };

    const res = await this.authorizedFetch(
      `${SHEETS_API}/${encodeURIComponent(fileId)}/values:batchUpdate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new SyncTransportError(
        'UNKNOWN',
        `Google Sheets Card ID batchUpdate failed (HTTP ${res.status}).`,
        res.status,
      );
    }
  }

  async createSheetFromTemplate(options: {
    title: string;
    headers: readonly string[];
    sampleRows?: ReadonlyArray<readonly string[]>;
  }): Promise<{ fileId: string; title: string; sheetTitle: string; uri: string }> {
    const createRes = await this.authorizedFetch(SHEETS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: { title: options.title.trim() || 'Flashcards Deck' },
        sheets: [{ properties: { title: 'Cards' } }],
      }),
    });

    if (!createRes.ok) {
      throw new SyncTransportError(
        'UNKNOWN',
        `Failed to create Google Sheet from template (HTTP ${createRes.status}).`,
        createRes.status,
      );
    }

    const created = (await createRes.json()) as {
      spreadsheetId?: string;
      spreadsheetUrl?: string;
      properties?: { title?: string };
      sheets?: Array<{ properties?: { title?: string } }>;
    };

    const fileId = created.spreadsheetId;
    if (!fileId) {
      throw new SyncTransportError('UNKNOWN', 'Sheets API did not return spreadsheetId.');
    }

    const sheetTitle = created.sheets?.[0]?.properties?.title ?? 'Cards';
    const title = created.properties?.title ?? options.title;
    const rows: string[][] = [[...options.headers]];
    if (options.sampleRows) {
      for (const r of options.sampleRows) {
        rows.push([...r]);
      }
    }

    const lastCol = columnIndexToA1(Math.max(0, options.headers.length - 1));
    const writeRes = await this.authorizedFetch(
      `${SHEETS_API}/${encodeURIComponent(fileId)}/values:batchUpdate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: [
            {
              range: `${quoteSheetTab(sheetTitle)}!A1:${lastCol}${rows.length}`,
              values: rows,
            },
          ],
        }),
      },
    );
    if (!writeRes.ok) {
      throw new SyncTransportError(
        'UNKNOWN',
        `Created Sheet but failed to write template headers (HTTP ${writeRes.status}).`,
        writeRes.status,
      );
    }

    return {
      fileId,
      title,
      sheetTitle,
      uri: created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
    };
  }

  async exportDocAsMarkdown(
    fileId: string,
  ): Promise<{ fileId: string; title: string; markdown: string; modifiedTime?: string }> {
    const [meta, exportRes] = await Promise.all([
      this.getFileMetadata(fileId),
      this.authorizedFetch(
        `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}/export?mimeType=text%2Fmarkdown`,
      ),
    ]);

    if (!exportRes.ok) {
      throw new SyncTransportError(
        'UNKNOWN',
        `Failed to export Google Doc as Markdown (HTTP ${exportRes.status}).`,
        exportRes.status,
      );
    }

    const markdown = await readTextCapped(exportRes, MAX_DOC_MARKDOWN_BYTES, {
      tooLarge: () =>
        new SyncTransportError(
          'UNKNOWN',
          `Google Doc export exceeds ${MAX_DOC_MARKDOWN_BYTES} byte safety limit.`,
        ),
    });

    return {
      fileId: meta.id,
      title: meta.name,
      markdown,
      ...(meta.modifiedTime !== undefined ? { modifiedTime: meta.modifiedTime } : {}),
    };
  }

  /** Plain Drive file metadata, for linked `.csv` / `.tsv` / `.xlsx` / `.flashpkg` files. */
  async getDriveFileInfo(fileId: string): Promise<GoogleDriveFileInfo> {
    return fetchDriveFileInfo(this.authorizedFetch, fileId);
  }

  /** Downloads a plain Drive file (`alt=media`, 50 MB cap). */
  async downloadDriveFile(fileId: string): Promise<PickedFile> {
    return downloadDriveFileBytes(this.authorizedFetch, fileId);
  }
}
