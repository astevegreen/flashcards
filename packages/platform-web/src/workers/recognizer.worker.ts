import {
  recognizeHandwriting,
  type HandwritingCandidate,
  type HandwritingRecognizeOptions,
  type InkStroke,
  type StrokeLookupIndex,
} from '@flash/core/drawing';

interface RecognizeWorkerRequest {
  id: number;
  type: 'recognize';
  strokes: readonly InkStroke[];
  indexes: readonly StrokeLookupIndex[];
  options: Omit<HandwritingRecognizeOptions, 'preferredChars'> & {
    preferredCharsList?: string[];
  };
}

interface RecognizeWorkerResponse {
  id: number;
  ok: true;
  candidates: HandwritingCandidate[];
}

interface RecognizeWorkerError {
  id: number;
  ok: false;
  error: string;
}

self.onmessage = (event: MessageEvent<RecognizeWorkerRequest>) => {
  const msg = event.data;
  try {
    const preferredChars =
      msg.options.preferredCharsList && msg.options.preferredCharsList.length > 0
        ? new Set(msg.options.preferredCharsList)
        : undefined;
    const candidates = recognizeHandwriting(msg.strokes, msg.indexes, {
      ...(msg.options.lang !== undefined ? { lang: msg.options.lang } : {}),
      ...(msg.options.maxResults !== undefined ? { maxResults: msg.options.maxResults } : {}),
      ...(msg.options.strokeCountTolerance !== undefined
        ? { strokeCountTolerance: msg.options.strokeCountTolerance }
        : {}),
      ...(preferredChars !== undefined ? { preferredChars } : {}),
    });
    const res: RecognizeWorkerResponse = { id: msg.id, ok: true, candidates };
    self.postMessage(res);
  } catch (err) {
    const res: RecognizeWorkerError = {
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(res);
  }
};
