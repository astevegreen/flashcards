import type { DownloadableBlob, Files, PickedFile, PickFileOptions } from '@flash/platform';

export class WebFiles implements Files {
  pickFile(options?: PickFileOptions): Promise<PickedFile | null> {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (options?.accept) {
        input.accept = options.accept;
      }
      let settled = false;
      const done = (val: PickedFile | null): void => {
        if (settled) return;
        settled = true;
        resolve(val);
      };
      // Not an async listener: a failed read must reject the pick, not leave it pending forever.
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) {
          done(null);
          return;
        }
        const maxBytes = options?.maxBytes;
        if (maxBytes !== undefined && file.size > maxBytes) {
          done({ name: file.name, bytes: new Uint8Array(0), size: file.size, tooLarge: true });
          return;
        }
        file.arrayBuffer().then(
          (buf) =>
            done({
              name: file.name,
              bytes: new Uint8Array(buf),
              ...(file.type ? { mime: file.type } : {}),
            }),
          reject,
        );
      });
      input.addEventListener('cancel', () => done(null));
      input.click();
    });
  }

  async downloadFile(filename: string, data: Uint8Array, mimeType: string): Promise<void> {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    await this.downloadBlob(filename, new Blob([copy], { type: mimeType }));
  }

  /** Saves a Blob as is (no copy), so large exports stay in the browser's Blob storage. */
  async downloadBlob(filename: string, blob: DownloadableBlob): Promise<void> {
    const url = URL.createObjectURL(blob as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
