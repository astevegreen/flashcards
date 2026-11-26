import type { AudioPlayer } from '@flash/platform';

/**
 * Minimal valid 44-byte silent PCM WAV (8 kHz, 8-bit mono, 0 samples) used once on the
 * first user gesture to synchronously unlock iOS Safari's shared `<audio>` element (§7.2).
 */
const SILENT_WAV_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x40, 0x1f, 0x00, 0x00, 0x40, 0x1f, 0x00, 0x00,
  0x01, 0x00, 0x08, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
]);

interface AudioWithPitchProps extends HTMLAudioElement {
  webkitPreservesPitch?: boolean;
  mozPreservesPitch?: boolean;
}

interface NavigatorWithAudioSession extends Navigator {
  audioSession?: {
    type: string;
  };
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1.0;
  return Math.max(0.5, Math.min(2.0, rate));
}

function applyPlaybackRate(audio: HTMLAudioElement, rate: number): void {
  const clamped = clampRate(rate);
  audio.defaultPlaybackRate = clamped;
  audio.playbackRate = clamped;
  const ext = audio as AudioWithPitchProps;
  try {
    ext.preservesPitch = true;
  } catch {
    // Ignore read-only environments
  }
  try {
    ext.webkitPreservesPitch = true;
  } catch {
    // Ignore
  }
  try {
    ext.mozPreservesPitch = true;
  } catch {
    // Ignore
  }
}

export interface WebAudioPlayerOptions {
  createAudioElement?: () => HTMLAudioElement;
}

/**
 * Single shared `HTMLAudioElement` player with iOS Safari silent-switch bypass
 * (`navigator.audioSession.type = 'playback'`), gesture unlock, and 2–3 card RAM
 * `ObjectURL` lookahead preloading (§7.2).
 */
export class WebAudioPlayer implements AudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private readonly createAudioElement: () => HTMLAudioElement;
  private readonly preloadedUrls = new Map<string, string>();
  private tempUrl: string | null = null;
  private silentUrl: string | null = null;
  private unlocked = false;
  private unlocking = false;
  private playGeneration = 0;

  constructor(options?: WebAudioPlayerOptions) {
    this.createAudioElement =
      options?.createAudioElement ??
      (() => {
        const el = new Audio();
        el.preload = 'auto';
        return el;
      });
  }

  private getAudio(): HTMLAudioElement | null {
    if (this.audio) return this.audio;
    if (typeof Audio === 'undefined' && !this.createAudioElement) return null;
    try {
      const el = this.createAudioElement();
      el.preload = 'auto';
      this.audio = el;
      return el;
    } catch {
      return null;
    }
  }

  /**
   * Synchronously unlocks the shared `<audio>` element and sets `navigator.audioSession.type = 'playback'`
   * on the first user gesture so iOS Safari plays aloud even when the hardware silent switch is enabled.
   */
  unlock(): void {
    if (typeof navigator !== 'undefined') {
      const nav = navigator as NavigatorWithAudioSession;
      if (nav.audioSession && nav.audioSession.type !== 'playback') {
        try {
          nav.audioSession.type = 'playback';
        } catch {
          // Ignore unsupported/restricted audioSession environments
        }
      }
    }

    if (this.unlocked || this.unlocking) return;

    const audio = this.getAudio();
    if (!audio || this.playGeneration > 0) return;

    if (typeof URL === 'undefined' || typeof Blob === 'undefined') return;
    this.unlocking = true;
    try {
      if (!this.silentUrl) {
        this.silentUrl = URL.createObjectURL(new Blob([SILENT_WAV_BYTES], { type: 'audio/wav' }));
      }
      const gen = this.playGeneration;
      audio.muted = true;
      audio.src = this.silentUrl;
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.then === 'function') {
        void playPromise
          .then(() => {
            this.unlocking = false;
            this.unlocked = true;
            if (this.playGeneration === gen) {
              audio.pause();
              audio.currentTime = 0;
              audio.muted = false;
            }
          })
          .catch(() => {
            // Do NOT mark unlocked on rejection (e.g. iOS Safari rejects play() during pointerdown
            // and requires retry on the subsequent click/touchend/keydown activation).
            this.unlocking = false;
            if (this.playGeneration === gen) {
              audio.muted = false;
            }
          });
      } else {
        this.unlocking = false;
        this.unlocked = true;
        audio.muted = false;
      }
    } catch {
      this.unlocking = false;
      audio.muted = false;
    }
  }

  preload(hash: string, bytes: Uint8Array, mime: string): void {
    const normHash = hash.trim().toLowerCase();
    if (!normHash || this.preloadedUrls.has(normHash)) return;
    if (typeof URL === 'undefined' || typeof Blob === 'undefined') return;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const url = URL.createObjectURL(new Blob([copy], { type: mime || 'audio/mpeg' }));
    this.preloadedUrls.set(normHash, url);
  }

  hasPreloaded(hash: string): boolean {
    return this.preloadedUrls.has(hash.trim().toLowerCase());
  }

  retainOnly(keepHashes: ReadonlySet<string>): void {
    const normalizedKeep = new Set<string>();
    for (const h of keepHashes) {
      normalizedKeep.add(h.trim().toLowerCase());
    }
    for (const [hash, url] of this.preloadedUrls.entries()) {
      if (!normalizedKeep.has(hash)) {
        this.preloadedUrls.delete(hash);
        if (typeof URL !== 'undefined') {
          URL.revokeObjectURL(url);
        }
      }
    }
  }

  /**
   * Synchronously begins playback of a RAM-preloaded clip with zero preceding `await`,
   * preserving iOS Safari user-gesture activation on card flip/advance (§7.2).
   */
  playPreloaded(hash: string, rate = 1.0): Promise<boolean> {
    const started = this.startPreloaded(hash, rate);
    return started
      ? started.then(
          () => true,
          () => false,
        )
      : Promise.resolve(false);
  }

  /**
   * Starts a preloaded clip synchronously (see `playPreloaded`). `null` when there is no clip or
   * no audio element; otherwise a promise that rejects with the playback error.
   */
  private startPreloaded(hash: string, rate: number): Promise<void> | null {
    const normHash = hash.trim().toLowerCase();
    const url = this.preloadedUrls.get(normHash);
    if (!url) return null;

    const audio = this.getAudio();
    if (!audio) return null;

    this.playGeneration += 1;
    audio.muted = false;
    if (audio.src !== url) {
      audio.src = url;
    } else {
      try {
        audio.currentTime = 0;
      } catch {
        // Ignore if not yet seekable
      }
    }
    applyPlaybackRate(audio, rate);

    try {
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        return p.then(() => {
          this.unlocked = true;
          this.unlocking = false;
        });
      }
      this.unlocked = true;
      this.unlocking = false;
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async play(bytes: Uint8Array, mime: string, rate = 1.0, cacheHash?: string): Promise<void> {
    if (cacheHash) {
      this.preload(cacheHash, bytes, mime);
      // A playback failure rejects, as it does without `cacheHash` (C25).
      await this.startPreloaded(cacheHash, rate);
      return;
    }

    const audio = this.getAudio();
    if (!audio || typeof URL === 'undefined' || typeof Blob === 'undefined') return;

    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const nextUrl = URL.createObjectURL(new Blob([copy], { type: mime || 'audio/mpeg' }));
    if (this.tempUrl) {
      URL.revokeObjectURL(this.tempUrl);
    }
    this.tempUrl = nextUrl;

    this.playGeneration += 1;
    audio.muted = false;
    audio.src = nextUrl;
    applyPlaybackRate(audio, rate);
    await audio.play();
    this.unlocked = true;
    this.unlocking = false;
  }

  stop(): void {
    this.playGeneration += 1;
    if (!this.audio) return;
    try {
      this.audio.pause();
      this.audio.currentTime = 0;
    } catch {
      // Ignore restricted context errors
    }
  }

  dispose(): void {
    this.stop();
    if (typeof URL !== 'undefined') {
      for (const url of this.preloadedUrls.values()) {
        URL.revokeObjectURL(url);
      }
      if (this.tempUrl) {
        URL.revokeObjectURL(this.tempUrl);
      }
      if (this.silentUrl) {
        URL.revokeObjectURL(this.silentUrl);
      }
    }
    this.preloadedUrls.clear();
    this.tempUrl = null;
    this.silentUrl = null;
    this.audio = null;
    this.unlocked = false;
    this.unlocking = false;
  }
}
