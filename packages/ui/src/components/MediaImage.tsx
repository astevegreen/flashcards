import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';

export interface MediaImageProps {
  src: string;
  alt?: string;
  className?: string;
}

const MEDIA_URI_RE = /^media:([0-9a-f]{64})$/i;

/**
 * Safe declarative image renderer (§13 + Option 1 CSP `img-src 'self' blob: data:`).
 * Resolves `media:<sha256>` from IndexedDB into a ref-cleaned `ObjectURL` that works 100% offline.
 * Blocks unsafe schemes (`javascript:`, `data:`, `http:`) and never triggers external network requests.
 */
export function MediaImage({ src, alt = '', className = '' }: MediaImageProps) {
  const { platform, stateVersion } = useApp();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'blocked'>('loading');
  const objectUrlRef = useRef<string | null>(null);
  const loadedHashRef = useRef<string | null>(null);

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
    if (!hash) {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      loadedHashRef.current = null;
      setObjectUrl(null);
      setStatus(trimmed ? 'blocked' : 'missing');
      return undefined;
    }

    // Already loaded this exact content-addressed hash: do NOT flicker or re-read IndexedDB on unrelated stateVersion bumps!
    if (loadedHashRef.current === hash && objectUrlRef.current) {
      return undefined;
    }

    let cancelled = false;
    setStatus('loading');

    void platform.storage
      .getMedia(hash)
      .then((blob) => {
        if (cancelled) return;
        if (!blob) {
          if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
          }
          loadedHashRef.current = null;
          setObjectUrl(null);
          setStatus('missing');
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
        setObjectUrl(url);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) {
          if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
          }
          loadedHashRef.current = null;
          setObjectUrl(null);
          setStatus('missing');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hash, platform.storage, stateVersion, trimmed]);

  if (!trimmed) return null;

  if (status === 'ready' && objectUrl) {
    return (
      <img
        src={objectUrl}
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
