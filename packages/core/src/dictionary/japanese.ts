/**
 * Japanese deinflection for dictionary lookup (`食べた` → `食べる`, `飲みたくなかった` → `飲む`).
 *
 * Rule-based and deliberately over-generating: every candidate is only a guess at a dictionary
 * form, and fetching those headwords from the pack is the validation step (candidates the pack
 * does not contain return nothing). Pure and deterministic, no I/O.
 */

/** `[inflected suffix, dictionary suffix]`; one step of un-inflecting. */
type Rule = readonly [string, string];

/** The u-row verb endings with their a / i / e / o row kana. */
const GODAN: ReadonlyArray<{ u: string; a: string; i: string; e: string; o: string }> = [
  { u: 'う', a: 'わ', i: 'い', e: 'え', o: 'お' },
  { u: 'く', a: 'か', i: 'き', e: 'け', o: 'こ' },
  { u: 'ぐ', a: 'が', i: 'ぎ', e: 'げ', o: 'ご' },
  { u: 'す', a: 'さ', i: 'し', e: 'せ', o: 'そ' },
  { u: 'つ', a: 'た', i: 'ち', e: 'て', o: 'と' },
  { u: 'ぬ', a: 'な', i: 'に', e: 'ね', o: 'の' },
  { u: 'ぶ', a: 'ば', i: 'び', e: 'べ', o: 'ぼ' },
  { u: 'む', a: 'ま', i: 'み', e: 'め', o: 'も' },
  { u: 'る', a: 'ら', i: 'り', e: 'れ', o: 'ろ' },
];

function buildRules(): Rule[] {
  const rules: Rule[] = [
    // Irregular (suru / kuru, and `行く` whose te-form is irregular).
    ['した', 'する'],
    ['して', 'する'],
    ['しない', 'する'],
    ['します', 'する'],
    ['しよう', 'する'],
    ['すれば', 'する'],
    ['される', 'する'],
    ['させる', 'する'],
    ['きた', 'くる'],
    ['きて', 'くる'],
    ['こない', 'くる'],
    ['きます', 'くる'],
    ['こよう', 'くる'],
    ['くれば', 'くる'],
    ['来た', '来る'],
    ['来て', '来る'],
    ['来ない', '来る'],
    ['来ます', '来る'],
    ['来よう', '来る'],
    ['来れば', '来る'],
    ['来られる', '来る'],
    ['行った', '行く'],
    ['行って', '行く'],
    ['いった', 'いく'],
    ['いって', 'いく'],
    // Ichidan.
    ['た', 'る'],
    ['て', 'る'],
    ['ない', 'る'],
    ['ます', 'る'],
    ['よう', 'る'],
    ['れば', 'る'],
    ['ろ', 'る'],
    ['られる', 'る'],
    ['れる', 'る'],
    ['させる', 'る'],
    ['ず', 'る'],
    // Godan past / te-form (the sound changes).
    ['った', 'う'],
    ['った', 'つ'],
    ['った', 'る'],
    ['って', 'う'],
    ['って', 'つ'],
    ['って', 'る'],
    ['んだ', 'ぬ'],
    ['んだ', 'ぶ'],
    ['んだ', 'む'],
    ['んで', 'ぬ'],
    ['んで', 'ぶ'],
    ['んで', 'む'],
    ['いた', 'く'],
    ['いて', 'く'],
    ['いだ', 'ぐ'],
    ['いで', 'ぐ'],
    ['した', 'す'],
    ['して', 'す'],
    // Chaining helpers: normalize to the plain polite / te / negative forms first.
    ['ません', 'ます'],
    ['ました', 'ます'],
    ['ましょう', 'ます'],
    ['ませんでした', 'ます'],
    ['なかった', 'ない'],
    ['たい', 'ます'],
    ['ている', 'て'],
    ['ていた', 'て'],
    ['てる', 'て'],
    ['でいる', 'で'],
    ['でいた', 'で'],
    // い-adjectives.
    ['くない', 'い'],
    ['かった', 'い'],
    ['くて', 'い'],
    ['ければ', 'い'],
    ['く', 'い'],
  ];
  for (const g of GODAN) {
    rules.push(
      [`${g.a}ない`, g.u],
      [`${g.i}ます`, g.u],
      [`${g.e}る`, g.u],
      [`${g.e}ば`, g.u],
      [`${g.o}う`, g.u],
      [`${g.a}れる`, g.u],
      [`${g.a}せる`, g.u],
      [`${g.a}ず`, g.u],
    );
  }
  // 行く-style `いた` / `いて` are covered above; `ろう` (godan る volitional) is `o + う`.
  return rules;
}

const RULES: readonly Rule[] = buildRules();

/** Cheap guard: only text that has Japanese script can be a Japanese inflection. */
const JAPANESE_SCRIPT = /[぀-ゟ゠-ヿ一-鿿]/;
const KANA_ONLY_TAIL = /[぀-ゟ]$/;

const MAX_DEPTH = 4;
const MAX_CANDIDATES = 80;

/**
 * Candidate dictionary forms of `word`, mapped to the number of un-inflecting steps (the query
 * itself is not included). Katakana-only input and words without a hiragana ending have none.
 */
export function deinflectJapanese(word: string): Map<string, number> {
  const out = new Map<string, number>();
  const text = word.normalize('NFC').trim();
  if (text.length < 2 || !JAPANESE_SCRIPT.test(text) || !KANA_ONLY_TAIL.test(text)) return out;

  let frontier: string[] = [text];
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const form of frontier) {
      for (const [from, to] of RULES) {
        if (!form.endsWith(from) || (form.length === from.length && to.length < 2)) continue;
        const candidate = form.slice(0, form.length - from.length) + to;
        if (candidate === text || out.has(candidate)) continue;
        out.set(candidate, depth);
        next.push(candidate);
        if (out.size >= MAX_CANDIDATES) return out;
      }
    }
    frontier = next;
  }
  return out;
}
