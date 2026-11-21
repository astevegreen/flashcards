import { parseMediaHashUri } from '@flash/core';
import { useApp } from '../state/AppContext.tsx';

export interface MediaAudioPlayerProps {
  src: string;
  label?: string;
  className?: string;
}

/**
 * Compact inline audio player for `field.kind === 'audio'` fields (cards & NoteEditDialog).
 * Strictly plays local `media:<sha256>` clips via the shared unlocked `AudioPlayer` (`media-src 'self' blob:`).
 */
export function MediaAudioPlayer({
  src,
  label = 'Audio clip',
  className = '',
}: MediaAudioPlayerProps) {
  const { state, audio } = useApp();
  const trimmed = src.trim();
  if (!trimmed) return null;

  const hash = parseMediaHashUri(trimmed);
  if (!hash) {
    return (
      <div
        data-testid="media-audio-blocked"
        className={`rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300 ${className}`.trim()}
      >
        {trimmed.startsWith('https://')
          ? 'External audio not cached locally. Upload the audio clip or re-import with CORS enabled for offline playback.'
          : 'Blocked unsafe audio reference.'}
      </div>
    );
  }

  const entry = state.media.get(hash);

  const handlePlay = (rate: number) => {
    audio.unlock();
    void audio.playMediaHash(hash, rate);
  };

  return (
    <div
      data-testid="media-audio-player"
      data-media-hash={hash}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex flex-wrap items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-xs ${className}`.trim()}
    >
      <button
        type="button"
        data-testid="media-audio-play"
        aria-label={`Play ${label} at normal speed`}
        onClick={() => handlePlay(1.0)}
        className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 py-1 font-semibold text-white hover:opacity-90 active:scale-95"
      >
        <span aria-hidden="true">▶</span>
        <span>1×</span>
      </button>
      <button
        type="button"
        data-testid="media-audio-slow"
        aria-label={`Play ${label} slowly at 0.75× speed`}
        onClick={() => handlePlay(0.75)}
        className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 font-medium text-[var(--fg)] hover:bg-[var(--surface-2)] active:scale-95"
      >
        0.75×
      </button>
      <span className="text-[11px] text-[var(--muted)]">
        {entry
          ? `${entry.ext.toUpperCase()} · ${Math.max(1, Math.round(entry.size / 1024))} KB`
          : `Clip (${hash.slice(0, 8)}…)`}
      </span>
    </div>
  );
}
