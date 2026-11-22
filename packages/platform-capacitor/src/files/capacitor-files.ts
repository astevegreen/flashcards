import type { Files, PickedFile } from '@flash/platform';

export interface CapacitorFileBridge {
  pickFile(opts?: { accept?: string }): Promise<PickedFile | null>;
  saveAndShareFile(opts: { filename: string; data: Uint8Array; mimeType: string }): Promise<void>;
}

export class CapacitorFiles implements Files {
  private readonly bridge?: CapacitorFileBridge;

  constructor(bridge?: CapacitorFileBridge) {
    if (bridge) this.bridge = bridge;
  }

  async pickFile(options?: { accept?: string }): Promise<PickedFile | null> {
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
