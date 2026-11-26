import { SyncTransportError } from '@flash/core';
import type { GoogleDriveFileInfo, PickedFile } from '@flash/platform';
import { readBodyCapped } from '../net/read-capped.ts';

/**
 * Plain Google Drive files (`.csv` / `.tsv` / `.xlsx` / `.flashpkg`) for linked sources (§3.1).
 * Only files the user picked with Google Picker are reachable: the app keeps the `drive.file`
 * scope and never asks for broader Drive access.
 */

const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';

/** Same cap as linked local-folder and OneDrive files. */
export const MAX_DRIVE_FILE_BYTES = 50 * 1024 * 1024;

/**
 * MIME types Google Picker shows for "Link from Google Drive". Drive stores what the uploader
 * sent, so a `.csv` can be `text/csv` or (Windows with Excel) `application/vnd.ms-excel`, and a
 * `.flashpkg` is usually `application/octet-stream` or a zip type. The app checks the picked
 * file's name before reading it. Keep in sync with `apps/web/public/picker.html`.
 */
export const GOOGLE_DRIVE_PICKER_MIME_TYPES: readonly string[] = [
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.document',
  'text/csv',
  'text/tab-separated-values',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
  'application/zip',
  'application/x-zip-compressed',
];

type DriveFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface DriveFileResponse {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  version?: string;
  webViewLink?: string;
  trashed?: boolean;
}

function tooLargeError(name: string): SyncTransportError {
  return new SyncTransportError('UNKNOWN', `"${name}" is larger than the 50 MB import limit.`);
}

/** `md5Checksum` changes only with the bytes; `version` and `modifiedTime` are fallbacks. */
export function driveContentTag(meta: {
  md5Checksum?: string;
  version?: string;
  modifiedTime?: string;
}): string | undefined {
  if (meta.md5Checksum) return `md5:${meta.md5Checksum}`;
  if (meta.version) return `v:${meta.version}`;
  if (meta.modifiedTime) return `t:${meta.modifiedTime}`;
  return undefined;
}

export async function fetchDriveFileInfo(
  driveFetch: DriveFetch,
  fileId: string,
): Promise<GoogleDriveFileInfo> {
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,size,modifiedTime,md5Checksum,version,webViewLink,trashed',
    supportsAllDrives: 'true',
  });
  const res = await driveFetch(
    `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}?${params.toString()}`,
  );
  if (!res.ok) {
    throw new SyncTransportError(
      'UNKNOWN',
      `Failed to read Google Drive file details (HTTP ${res.status}).`,
      res.status,
    );
  }
  const data = (await res.json()) as DriveFileResponse;
  const size = data.size !== undefined ? Number.parseInt(data.size, 10) : Number.NaN;
  const contentTag = driveContentTag(data);
  return {
    id: data.id ?? fileId,
    name: data.name ?? fileId,
    mimeType: data.mimeType ?? 'application/octet-stream',
    ...(Number.isFinite(size) ? { size } : {}),
    ...(data.modifiedTime !== undefined ? { modifiedTime: data.modifiedTime } : {}),
    ...(data.md5Checksum !== undefined ? { md5Checksum: data.md5Checksum } : {}),
    ...(data.version !== undefined ? { version: data.version } : {}),
    ...(data.webViewLink !== undefined ? { webViewLink: data.webViewLink } : {}),
    ...(data.trashed !== undefined ? { trashed: data.trashed } : {}),
    ...(contentTag !== undefined ? { contentTag } : {}),
  };
}

/**
 * Downloads one plain Drive file with `files.get?alt=media`. Google Docs/Sheets can't be
 * downloaded this way (they are linked through the Sheets/Docs APIs), and a file over the cap
 * is refused before and while downloading.
 */
export async function downloadDriveFileBytes(
  driveFetch: DriveFetch,
  fileId: string,
  maxBytes: number = MAX_DRIVE_FILE_BYTES,
): Promise<PickedFile> {
  const info = await fetchDriveFileInfo(driveFetch, fileId);
  if (info.trashed) {
    throw new SyncTransportError('NOT_FOUND', `"${info.name}" is in the Google Drive trash.`);
  }
  if (info.mimeType.startsWith('application/vnd.google-apps.')) {
    throw new SyncTransportError(
      'UNKNOWN',
      `"${info.name}" is a Google Docs file, not a .csv, .tsv, .xlsx or .flashpkg file.`,
    );
  }
  if (info.size !== undefined && info.size > maxBytes) throw tooLargeError(info.name);
  const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
  const res = await driveFetch(
    `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}?${params.toString()}`,
  );
  if (!res.ok) {
    throw new SyncTransportError(
      'UNKNOWN',
      `Failed to download "${info.name}" from Google Drive (HTTP ${res.status}).`,
      res.status,
    );
  }
  const bytes = await readBodyCapped(res, maxBytes, { tooLarge: () => tooLargeError(info.name) });
  return { name: info.name, bytes, mime: info.mimeType, size: bytes.byteLength };
}
