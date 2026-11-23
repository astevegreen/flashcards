# Starter-deck gloss review

Status: **for owner review.** Nothing in `packages/core/src/starters/generated/` or `scripts/build-starter-decks.mjs` was changed. This answers the "Gloss quality" item in `docs/follow-ups.md`.

## Scope and method

- Korean: `ko-core.ts`, 145 notes (NIKL level A, English from Wikidata lexemes, CC0).
- Mandarin: `zh-common.ts`, 150 notes (Unihan 17.0.0 `kDefinition`, Unicode License v3).
- I read every gloss in both decks. The tables list the ones I would change. Glosses not listed look fine for a beginner card.
- Suggested fixes are my own wording, a starting point for the owner, not final copy.
- I did **not** look up Wikidata lexemes, Unihan entries or CLDR online in this pass. Where a gloss "reads like" an item description, that is inferred from the wording, not confirmed.

## Patterns

1. **Dictionary-definition glosses.** Several Wikidata glosses are descriptions, not translations (경찰, 공항, 안경, 건물, 대학교). A learner wants "police", not a sentence.
2. **Wrong or missing sense for homonyms.** 개 (dog), 해 (sun), 일 (work / one).
3. **Grammar labels instead of meanings**: "(adverb of negation)", "(negative copula)".
4. **Ambiguous card fronts.** 일 (work) and 일 (一), 이 (this) and 이 (二), 팔 (arm) and 팔 (八) are separate cards with the same front. Numerals say only "the number N" or just "one", so native vs Sino-Korean is not stated.
5. **Unihan `kDefinition` is a classical-character dictionary gloss.** It often lists a classical sense before the one a Mandarin learner needs (后 "queen", 几 "small table", 什 "file of ten soldiers", 没 "drown, sink"). Particles (着, 么, 呢) get a vague or wrong sense. "Kangxi radical N" and star or earthly-branch notes are noise on a beginner card.
6. **Inconsistent format.** Mixed "to X" and bare verbs; "100" vs "the number 3"; pasted duplicate senses ("banana plant (Musa acuminata); banana plant (fruit)").

## Korean: glosses to change

| Word               | Current gloss                                                                                                   | Problem                                                        | Suggested fix                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| 개                 | domestic animal                                                                                                 | Encyclopedic; does not name the animal                         | dog (also a counter for items)                                 |
| 해                 | year                                                                                                            | Misses the main sense                                          | sun; year                                                      |
| 일 (noun)          | working/laboring (as a means of support)                                                                        | Definition                                                     | work; task; matter                                             |
| 일 (一)            | the number 1                                                                                                    | Does not say Sino-Korean                                       | one (Sino-Korean number)                                       |
| 하나               | one                                                                                                             | Does not say native                                            | one (native Korean number)                                     |
| 사람               | human                                                                                                           | Biological, not everyday                                       | person; people                                                 |
| 마음               | mind                                                                                                            | Misses "heart / feelings"                                      | heart; mind; feelings                                          |
| 길                 | road                                                                                                            | Narrow                                                         | road; way; path                                                |
| 물                 | clear liquid H₂O                                                                                                | Encyclopedic                                                   | water                                                          |
| 안                 | (adverb of negation)                                                                                            | Grammar label                                                  | not (before a verb: 안 가요 "I'm not going")                   |
| 못                 | cannot                                                                                                          | Incomplete                                                     | cannot; unable to (못 가요 "can't go")                         |
| 아니               | (literary adverb of negation)                                                                                   | "Literary" is misleading; also the everyday interjection "no!" | no!; not (variant of 안)                                       |
| 아니다             | (negative copula)                                                                                               | Grammar label                                                  | to not be; is not (A은/는 B이/가 아니다)                       |
| 않다               | to not do (something)                                                                                           | Vague                                                          | (auxiliary) to not; -지 않다 "do not"                          |
| 있다               | to be (remain in a place)                                                                                       | Misses "have" and "exist"                                      | to be (there); to exist; to have                               |
| 없다               | non-existent                                                                                                    | Adjective-style gloss for a verb-like word                     | to not be (there); to not exist; to not have                   |
| 그 (determiner)    | that (something close to the listener or that the listener thinks of); that (something just recently mentioned) | Too long for a card                                            | that (near you / just mentioned)                               |
| 그 (pronoun)       | he or she (informal third person pronoun); that                                                                 | Muddled                                                        | he; that (person)                                              |
| 이 (determiner)    | this (something close to the speaker …); this (something just recently mentioned)                               | Too long                                                       | this                                                           |
| 이 (二)            | the number 2                                                                                                    | Collides with 이 "this"                                        | two (Sino-Korean number)                                       |
| 저                 | that over there                                                                                                 | Terse                                                          | that (over there, away from both of us)                        |
| 나                 | informal first person singular, I                                                                               | Cumbersome                                                     | I; me (casual)                                                 |
| 우리               | we                                                                                                              | Misses "our"                                                   | we; our                                                        |
| 아무               | anyone                                                                                                          | Mostly used with negatives                                     | any; (with a negative) no one, nothing                         |
| 보다               | see; look at; notice (To perceive with eyes …); watch; see; enjoy (…); read; look at; take a look at (…)        | Pasted definitions, repeated senses                            | to see; to look at; to watch; to read                          |
| 입다               | to wear (e.g. clothes); to suffer due to something received (e.g. loss or injury)                               | Second sense is not level A                                    | to wear (clothes)                                              |
| 일하다             | to work/labor; to work/serve                                                                                    | Duplicate                                                      | to work                                                        |
| 명                 | classifier for people (informal)                                                                                | "Informal" is misleading; 명 is the standard people counter    | counter for people (두 명 "two people")                        |
| 년                 | year                                                                                                            | Does not say it is a counter                                   | year (as in 2025년)                                            |
| 경찰               | constituted body of persons empowered by the state to enforce the law                                           | Definition                                                     | police; police officer                                         |
| 건물               | structure, typically with a roof and walls, standing more or less permanently in one place                      | Definition                                                     | building                                                       |
| 공항               | location where aircraft take off and land with extended support facilities for aircraft operation               | Definition                                                     | airport                                                        |
| 안경               | optical device to assist human vision                                                                           | Definition                                                     | glasses                                                        |
| 대학교             | institution of higher education                                                                                 | Definition                                                     | university                                                     |
| 바나나             | banana plant (Musa acuminata); banana plant (fruit)                                                             | Duplicate, botanical                                           | banana                                                         |
| 버스               | bus (passenger vehicle); bus (data transfer system)                                                             | Computing sense is irrelevant                                  | bus                                                            |
| 고기               | meat (that is eaten)                                                                                            | Awkward                                                        | meat                                                           |
| 샤워               | showering                                                                                                       | Gerund                                                         | shower (washing)                                               |
| 자동차             | automobile                                                                                                      | Stiff                                                          | car                                                            |
| 시계               | clock                                                                                                           | Misses "watch"                                                 | clock; watch                                                   |
| 결혼               | marriage                                                                                                        | Misses "wedding"                                               | marriage; wedding                                              |
| 우유               | cow's milk                                                                                                      | Over-specific                                                  | milk                                                           |
| 속                 | the inside of something (particularly that with some covering around it)                                        | Definition                                                     | inside; within                                                 |
| 처음               | the first (thing in some order, temporal or otherwise)                                                          | Definition                                                     | first time; beginning; at first                                |
| 안녕               | (friendly greeting both in meeting and in parting)                                                              | Not a gloss                                                    | hi; bye (casual greeting)                                      |
| 안녕하다           | peaceful or tranquil; well and healthy                                                                          | Does not link to the greeting                                  | to be well (안녕하세요 "hello")                                |
| 안녕히             | well and healthily                                                                                              | Does not link to the farewell                                  | well; in peace (안녕히 가세요 "goodbye")                       |
| 새                 | new (recently created)                                                                                          | Parenthesis adds nothing                                       | new (before a noun)                                            |
| 첫째               | first                                                                                                           | Misses "eldest"                                                | first; eldest child                                            |
| 밝다               | be bright                                                                                                       | Grammar form                                                   | to be bright                                                   |
| 열                 | ten                                                                                                             | Does not say native                                            | ten (native Korean number)                                     |
| 백, 천, 십, 이십 … | 100 / the number 1000 / the number 10 / twenty                                                                  | Inconsistent format; Sino-Korean not stated                    | one hundred; one thousand; ten; twenty (Sino-Korean number)    |
| 쉰, 마흔, 서른 …   | fifty, forty, thirty                                                                                            | Native not stated                                              | fifty (native Korean number), etc.                             |
| 팔 (arm) / 팔 (八) | arm (of a living being) / the number 8                                                                          | Same front                                                     | arm / eight (Sino-Korean number); consider a hint on the front |

## Mandarin: glosses to change

"Suggested fix" is the sense a beginner needs first, in plain English.

| Char | Pinyin | Current gloss                                                                              | Problem                                                        | Suggested fix                                        |
| ---- | ------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------- |
| 的   | de     | possessive, adjectival suffix                                                              | Terse, no usage                                                | possessive particle: 's (我的 "my")                  |
| 着   | zhe    | make move, take action                                                                     | Wrong sense for this reading                                   | continuous-aspect particle (-ing)                    |
| 么   | me     | interrogative particle; small                                                              | "small" belongs to another character                           | suffix in 什么 "what", 怎么 "how"                    |
| 呢   | ne     | interrogative or emphatic final                                                            | Incomplete                                                     | sentence-final particle ("and you?", "still …")      |
| 呐   | nà     | raise voice, yell out loud, shout; stammer                                                 | Not the common use                                             | sentence-final particle (exclamation)                |
| 个   | gè     | numerary adjunct, piece; single                                                            | Jargon                                                         | general measure word                                 |
| 地   | dì     | earth; soil, ground; region                                                                | Misses the adverb particle                                     | earth; ground; adverb particle (-ly)                 |
| 得   | dé     | obtain, get, gain, acquire                                                                 | Misses the complement particle de                              | to get; complement particle (跑得快 "runs fast")     |
| 和   | hé     | harmony, peace; peaceful, calm                                                             | Misses the main sense                                          | and; with; harmony                                   |
| 要   | yào    | necessary, essential; necessity                                                            | Misses "want"                                                  | to want; will; must                                  |
| 里   | lǐ     | unit of distance; village; lane; Kangxi radical 166                                        | Misses "inside" (simplified 裡)                                | inside; Chinese mile                                 |
| 会   | huì    | assemble, meet together; meeting                                                           | Misses "can / will"                                            | can; will; meeting                                   |
| 为   | wèi    | do, handle, govern, act; be                                                                | Misses "for"                                                   | for; because of; (wéi) to be                         |
| 都   | dōu    | metropolis, capital; all, the whole; elegant, refined                                      | "Metropolis" first                                             | all; both; (dū) capital                              |
| 没   | méi    | not, have not, none; drown, sink                                                           | "drown, sink" is noise                                         | not; have not (没有)                                 |
| 把   | bǎ     | hold, take; guard; regard as                                                               | Grammar use not mentioned                                      | particle placing the object before the verb; to hold |
| 发   | fā     | issue, dispatch, send out; hair                                                            | "Hair" is 髮, not this character's usual use                   | to send out; to emit; to develop                     |
| 后   | hòu    | queen, empress, sovereign; (simp. for 後) behind, rear, after                              | Misleading: modern use is "after / behind"                     | after; behind; later                                 |
| 什   | shén   | file of ten soldiers; mixed, miscellaneous                                                 | Misleading: used in 什么                                       | what (in 什么)                                       |
| 几   | jǐ     | small table                                                                                | Misleading: modern use is "how many"                           | how many; several                                    |
| 全   | quán   | maintain, keep whole or intact                                                             | Unusual sense first                                            | whole; all; complete                                 |
| 只   | zhǐ    | only, just, simply                                                                         | Misses 只 zhī                                                  | only; just; (zhī) measure word for animals           |
| 甚   | shèn   | great extent; considerably                                                                 | Rare alone                                                     | very; extremely (甚至 "even")                        |
| 然   | rán    | yes, certainly; pledge, promise                                                            | Misleading                                                     | so; like that (然后 "then")                          |
| 儿   | ér     | son, child; Kangxi radical 10                                                              | Misses the suffix                                              | child; son; suffix (女儿 "daughter")                 |
| 子   | zǐ     | offspring, child; fruit, seed of; first earthly branch                                     | Earthly branch is noise                                        | child; noun suffix (桌子 "table")                    |
| 种   | zhǒng  | seed; race, breed; to plant                                                                | Misses "kind"                                                  | kind; type; seed                                     |
| 点   | diǎn   | dot, speck, spot; point, degree                                                            | Misses "o'clock"                                               | dot; point; o'clock                                  |
| 从   | cóng   | from, by, since, whence, through                                                           | "Whence" is archaic                                            | from; since                                          |
| 老   | lǎo    | old, aged; experienced; Kangxi radical 125                                                 | Kangxi noise                                                   | old; experienced; prefix (老师 "teacher")            |
| 于   | yú     | in, on, at; go to; surname                                                                 | "Surname" distracts                                            | in; at; to; (formal) from                            |
| 而   | ér     | and; and then; and yet; but; Kangxi radical 126                                            | Kangxi noise                                                   | and; but; yet                                        |
| 心   | xīn    | heart; mind, intelligence; soul; 5th lunar mansion, determinative star α Scorpii (Antares) | Encyclopedic tail                                              | heart; mind                                          |
| 两   | liǎng  | two, both, pair, couple; ounce                                                             | Misses usage                                                   | two (before measure words); a few                    |
| 行   | xíng   | go; walk; move, travel; circulate; Kangxi radical 144                                      | Misses "OK" and háng                                           | OK; to walk; to do; (háng) row, profession           |
| 长   | zhǎng  | long; length; excel in; leader                                                             | Sense and reading mismatch (cháng = long; zhǎng = grow, elder) | (cháng) long; (zhǎng) to grow; chief                 |
| 高   | gāo    | high, tall; lofty, elevated; Kangxi radical 189                                            | Kangxi noise                                                   | tall; high                                           |
| 当   | dāng   | bear, accept, undertake; just                                                              | Unnatural                                                      | to act as; when; just at the time of                 |
| 机   | jī     | desk; machine; moment                                                                      | "Desk" is rare in modern use                                   | machine; chance (飞机 "plane")                       |
| 气   | qì     | steam, vapor; Kangxi radical 84                                                            | Misses "air / breath / anger"                                  | air; gas; breath; anger                              |
| 己   | jǐ     | self, oneself; personal, private; 6th heavenly stem                                        | Stem is noise                                                  | self (in 自己 "oneself")                             |
| 所   | suǒ    | place, location; numerary adjunct                                                          | Misses "that which"                                            | place; (grammar) that which (所以 "so")              |
| 等   | děng   | rank, grade; to wait; equal, "and so forth"                                                | "Wait" should come first                                       | to wait; and so on                                   |
| 社   | shè    | god of the soil and altars to him; group of families; company, society                     | Archaic first sense                                            | society; agency (社会 "society")                     |
| 候   | hòu    | wait; expect; visit; greet                                                                 | Mostly seen in 时候                                            | wait; (时候 "time, moment")                          |
| 之   | zhī    | marks preceding phrase as modifier of following phrase; it, him her, them; go to           | Literary and long                                              | literary "of"                                        |
| 使   | shǐ    | cause, send on a mission, order; envoy, messenger, ambassador                              | Long                                                           | to cause; to use; to make (someone do)               |
| 打   | dǎ     | strike, hit, beat; fight; attack                                                           | Misses "play" and "make (a call)"                              | to hit; to play (a sport); to make (a call)          |
| 叫   | jiào   | cry, shout; hail, greet, call                                                              | Misses "to be called"                                          | to call; to be called; to shout                      |
| 他   | tā     | other, another; he, she, it                                                                | "Other" leads                                                  | he; him                                              |
| 我   | wǒ     | our, us, i, me, my, we                                                                     | Jumbled order, lowercase "i"                                   | I; me; my                                            |
| 来   | lái    | come, coming; return, returning                                                            | "-ing" forms are noise                                         | to come                                              |

## Where a fix could come from

Only CC0 and Unicode License v3 sources are listed. Nothing share-alike is proposed.

| Source                                                           | Licence                                       | Use for                                                                              | Notes                                                                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Owner-written glosses (an override table in `scripts/starters/`) | No third-party licence (the owner's own text) | Every row above. About 295 notes is small enough to review by hand.                  | The most reliable fix. Keep it as data next to the pinned sources.                                                                |
| Other senses of the same Wikidata lexeme                         | CC0 1.0                                       | Korean glosses where the build picked a descriptive sense                            | The build takes "up to three" glosses per word. Choosing the shortest sense may fix many rows. Not checked per word in this pass. |
| Unicode CLDR English names                                       | Unicode License v3                            | Month and weekday names, "South Korean won", "Korean"                                | A locale-data set, not a dictionary: no gloss text for general nouns or verbs.                                                    |
| Unihan `kDefinition` of the Hanja character                      | Unicode License v3                            | Cross-checking Sino-Korean numerals and characters (一 "one", 月 "month", 年 "year") | The same terse source already used for the Mandarin deck.                                                                         |

Considered and rejected (share-alike): Wiktionary, KENGDIC, CC-CEDICT, JMdict and the 한국어기초사전 definitions.

## Decisions needed

1. Hand-written overrides for the rows above, or a rule that shortens glosses (shortest Wikidata sense; drop text in parentheses)?
2. Disambiguate homonyms on the card front, e.g. `일 (一)` vs `일 (work)`?
3. Should particles get a usage example in the empty `example` field, or stay as terse single-sense text?

If an override table is added, rebuild with `node scripts/build-starter-decks.mjs`, then run it with `--check`, as `docs/follow-ups.md` notes.

## Unverified

- No live look-up of Wikidata lexemes, Unihan entries or CLDR was made, so which source a bad Korean gloss comes from is inferred.
- Suggested fixes are my own wording and have not been reviewed by a Korean or Mandarin speaker.
- Read from the decks as of commit cf22415; a later rebuild may differ.
