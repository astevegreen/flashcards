import type { KnownEvent } from './types.ts';

// Payload checks replay runs before it applies a known event. An event from a newer schema
// (`v` > 1), or one whose payload would make replay, the scheduler or the views throw, is kept
// verbatim in `unknownEvents` instead (§4.2): one bad event from a buggy or newer build must never
// stop the collection loading on every device. Only fields replay relies on are checked. This
// module is in the initial chunk (§8), so the checks stay terse.

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNum = (x: unknown): x is number => Number.isFinite(x);
const isArr = Array.isArray;
const isStrArr = (x: unknown): boolean => isArr(x) && x.every(isStr);
/** `x` is absent or passes `check`. */
const opt = (x: unknown, check: (y: unknown) => boolean): boolean => x === undefined || check(x);
/** ts-fsrs throws on a retention outside (0, 1]. */
const isRetention = (r: unknown): boolean => isNum(r) && r > 0 && r <= 1;
const isSettings = (s: unknown): boolean =>
  isObj(s) && opt(s['target_retention'], isRetention) && opt(s['enabled_layout_ids'], isStrArr);

/** True when replay can apply `event`; otherwise it stays in `unknownEvents`. */
export function isApplicableEvent(event: KnownEvent): boolean {
  const p: unknown = event.payload;
  if (event.v > 1 || !isObj(p)) return false;
  // Every id a payload carries (`deck_id`, `card_id`, `note_type_id`…) is a string.
  for (const key in p) if (key.endsWith('_id') && !isStr(p[key])) return false;
  switch (event.type) {
    case 'ReviewRecorded':
      return [1, 2, 3, 4].includes(p['rating'] as number) && isNum(p['reviewed_at']);
    case 'DeckCreated':
      return isStr(p['name']) && opt(p['settings'], isSettings);
    case 'DeckSettingsChanged':
      return opt(p['settings'], isSettings);
    case 'DeckFSRSParamsChanged': {
      // ts-fsrs also throws on a weight set that is not 17, 19 or 21 numbers long.
      const c = p['params'];
      return (
        isNum(p['params_version']) &&
        isNum(p['effective_from']) &&
        isObj(c) &&
        opt(c['request_retention'], isRetention) &&
        opt(c['w'], (w) => isArr(w) && [17, 19, 21].includes(w.length) && w.every(isNum))
      );
    }
    case 'NoteUpserted': {
      const fields = p['fields'];
      return isObj(fields) && Object.values(fields).every(isStr) && opt(p['tags'], isStrArr);
    }
    case 'PageUpserted':
      return opt(p['tags'], isStrArr);
    case 'NoteTypeChanged': {
      const nt = p['note_type'];
      return isObj(nt) && isArr(nt['fields']) && nt['fields'].every(isObj);
    }
    case 'LayoutChanged': {
      const l = p['layout'];
      return (
        isObj(l) &&
        isStrArr(l['front_fields']) &&
        isArr(l['reveal_steps']) &&
        l['reveal_steps'].every(isStrArr)
      );
    }
    case 'CourseChanged': {
      const c = p['course'];
      return isObj(c) && isArr(c['items']) && c['items'].every(isObj);
    }
    case 'MediaAdded': {
      const m = p['media'];
      return isObj(m) && isStr(m['hash']) && isStr(m['ext']);
    }
    case 'SourceLinked':
      return isObj(p['source']);
    case 'PreferencesChanged':
      return isObj(p['preferences']);
    default:
      // ReviewUndone, NoteArchived, NoteRestored, PageRead, MediaRemoved, SourceUnlinked,
      // CardSuspended, CardUnsuspended and NoteTagsAdded need only their ids, or skip a
      // malformed payload themselves.
      return true;
  }
}
