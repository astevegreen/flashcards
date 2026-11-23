/**
 * Media file types the importers accept (§13). Anything else (SVG, HTML, video, unknown) is
 * dropped: SVG can carry script, and every accepted type renders through `<img>` / audio only.
 *
 * A `Map`, not an object literal: extensions come from untrusted archives, and a plain-object
 * lookup would accept inherited keys such as `constructor` or `__proto__`.
 */
export const SAFE_MEDIA_MIME_BY_EXT: ReadonlyMap<string, string> = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['mp3', 'audio/mpeg'],
  ['ogg', 'audio/ogg'],
  ['wav', 'audio/wav'],
  ['m4a', 'audio/mp4'],
]);

/** The extension (lower-case, no dot) for an accepted media MIME type, or `undefined`. */
export function safeMediaExtForMime(mime: string): string | undefined {
  const want = mime.toLowerCase();
  for (const [ext, m] of SAFE_MEDIA_MIME_BY_EXT) if (m === want) return ext;
  return undefined;
}

/** The MIME type for an accepted media extension (lower-case, no dot), or `undefined`. */
export function safeMediaMimeForExt(ext: string): string | undefined {
  return SAFE_MEDIA_MIME_BY_EXT.get(ext);
}
