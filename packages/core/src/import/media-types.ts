/**
 * Media file types the importers accept (§13). Anything else (SVG, HTML, video, unknown) is
 * dropped: SVG can carry script, and every accepted type renders through `<img>` / audio only.
 */
export const SAFE_MEDIA_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
};
