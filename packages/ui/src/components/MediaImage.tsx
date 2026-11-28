import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';

export interface MediaImageProps {
  src: string;
  alt?: string;
  className?: string;
}

const MEDIA_URI_RE = /^media:([0-9a-f]{64})$/i;

/**
 * A missing file is looked for again after a collection change (a sync may have brought it), but at
 * most this often: a study session must not re-read IndexedDB after every rating (P9).
 */
export const MISSING_MEDIA_RETRY_MS = 5_000;

/**
 * How long to wait before reading `hash` again: 0 to read now (a new hash, or the last look was
 * over {@link MISSING_MEDIA_RETRY_MS} ago), else the rest of the interval since it was found missing.
 */
export function missingMediaRetryDelay(
  missing: { hash: string; atMs: number } | null,
  hash: string,
  nowMs: number = Date.now(),
): number {
  if (missing?.hash !== hash) return 0;
  return Math.max(0, missing.atMs + MISSING_MEDIA_RETRY_MS - nowMs);
}

/**
 * Safe declarative image renderer (§13 + Option 1 CSP `img-src 'self' blob: data:`).
 * Resolves `media:<sha256>` from IndexedDB into a ref-cleaned `ObjectURL` that works 100% offline.
 * Blocks unsafe schemes (`javascript:`, `data:`, `http:`) and never triggers external network requests.
 */
export function MediaImage({ src, alt = '', className = '' }: MediaImageProps) {
  const { platform, stateVersion } = useApp();
  // The object URL for the last hash read, and the last hash found missing: what shows is derived
  // from them and the current `src` during render, so a new `src` never waits on an effect.
  const [loaded, setLoaded] = useState<{ hash: string; url: string } | null>(null);
  const [missingHash, setMissingHash] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const loadedHashRef = useRef<string | null>(null);
  // The hash last found missing, and when it was looked for.
  const missingRef = useRef<{ hash: string; atMs: number } | null>(null);

  const trimmed = src.trim();
  const mediaMatch = MEDIA_URI_RE.exec(trimmed);
  const hash = mediaMatch?.[1]?.toLowerCase() ?? null;

  // Revoke any active ObjectURL on unmount
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      loadedHashRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Not a media reference: nothing to read, so release any loaded object URL now. Switching back
    // to that hash reads it again.
    if (!hash) {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
        setLoaded(null);
      }
      loadedHashRef.current = null;
      return undefined;
    }

    // Already loaded this exact content-addressed hash: do NOT flicker or re-read IndexedDB on unrelated stateVersion bumps!
    if (loadedHashRef.current === hash && objectUrlRef.current) {
      return undefined;
    }

    let cancelled = false;
    const missing = missingRef.current?.hash === hash ? missingRef.current : null;
    const markMissing = () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      loadedHashRef.current = null;
      missingRef.current = { hash, atMs: Date.now() };
      setLoaded(null);
      setMissingHash(hash);
    };

    const load = () =>
      platform.storage
        .getMedia(hash)
        .then((blob) => {
          if (cancelled) return;
          if (!blob) {
            markMissing();
            return;
          }
          const copy = new Uint8Array(blob.bytes.byteLength);
          copy.set(blob.bytes);
          const url = URL.createObjectURL(new Blob([copy], { type: blob.mime }));
          if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
          }
          objectUrlRef.current = url;
          loadedHashRef.current = hash;
          missingRef.current = null;
          setLoaded({ hash, url });
          setMissingHash(null);
        })
        .catch(() => {
          if (!cancelled) markMissing();
        });

    // Still missing: keep showing that, and look again only once the retry interval has passed.
    const waitMs = missingMediaRetryDelay(missing, hash);
    if (waitMs > 0) {
      const timer = window.setTimeout(() => void load(), waitMs);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [hash, platform.storage, stateVersion]);

  if (!trimmed) return null;

  let status: 'loading' | 'ready' | 'missing' | 'blocked';
  if (!hash) status = 'blocked';
  else if (loaded?.hash === hash) status = 'ready';
  else if (missingHash === hash) status = 'missing';
  else status = 'loading';

  if (status === 'ready' && loaded) {
    return (
      <img
        src={loaded.url}
        alt={alt}
        loading="lazy"
        decoding="async"
        data-testid="media-image"
        data-media-hash={hash ?? undefined}
        className={`max-h-64 max-w-full rounded-xl object-contain ${className}`.trim()}
      />
    );
  }

  if (status === 'loading') {
    return (
      <div
        data-testid="media-image-loading"
        className="flex h-24 w-40 items-center justify-center rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)] text-xs text-[var(--muted)]"
      >
        Loading image…
      </div>
    );
  }

  if (status === 'blocked') {
    return (
      <div
        data-testid="media-image-blocked"
        className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
      >
        {trimmed.startsWith('https://')
          ? 'External image not cached locally. Upload the image or re-import with CORS enabled for offline display.'
          : 'Blocked unsafe image reference.'}
      </div>
    );
  }

  return (
    <div
      data-testid="media-image-missing"
      className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--muted)]"
    >
      Image pending sync ({hash?.slice(0, 8)}…)
    </div>
  );
}
