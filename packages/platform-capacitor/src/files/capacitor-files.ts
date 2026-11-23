import type { Files, FileSink, PickedFile, PickFileOptions } from '@flash/platform';

export interface CapacitorFileBridge {
  pickFile(opts?: PickFileOptions): Promise<PickedFile | null>;
  saveAndShareFile(opts: { filename: string; data: Uint8Array; mimeType: string }): Promise<void>;
  /** Optional chunked save (cache file, then share sheet). */
  openSaveStream?(filename: string): FileSink;
}

export class CapacitorFiles implements Files {
  private readonly bridge?: CapacitorFileBridge;
  readonly saveStream?: (filename: string, mimeType: string) => Promise<FileSink | null>;

  constructor(bridge?: CapacitorFileBridge) {
    if (bridge) this.bridge = bridge;
    const open = bridge?.openSaveStream;
    if (open) this.saveStream = async (filename) => open.call(bridge, filename);
  }

  async pickFile(options?: PickFileOptions): Promise<PickedFile | null> {
    if (this.bridge) {
      return this.bridge.pickFile(options);
    }
    return null;
  }

  async downloadFile(filename: string, data: Uint8Array, mimeType: string): Promise<void> {
    if (this.bridge) {
      await this.bridge.saveAndShareFile({ filename, data, mimeType });
      return;
    }
    throw new Error('Native Capacitor file bridge unavailable.');
  }
}
