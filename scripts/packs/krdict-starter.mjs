/**
 * Tiny hand-authored Korean starter fixture for `dict-krdict` (dev mode, `pnpm test`, CI, e2e).
 *
 * The entries below were written for this project (definitions and examples are original, not
 * copied from 한국어기초사전); they only follow KRDict's structure so the starter build exercises
 * the real `parseKrdictXml` path. Pronunciations omit vowel-length marks (ː). Released with the
 * pack under CC BY-SA 2.0 KR so the starter and full packs carry the same licence metadata.
 *
 * Row shape: [headword, partOfSpeech (KRDict 품사), level (초급/중급/고급), origin (원어) | '',
 *             pronunciation, conjugations[], senses[[englishEquivalents, englishDefinition, examples[]]]]
 */
// prettier-ignore
export const KRDICT_STARTER_ROWS = [
  ['먹다', '동사', '초급', '', '먹따', ['먹어', '먹으니', '먹는'], [
    ['eat', 'To put food in the mouth, chew it and swallow it.', ['밥을 먹다.', '저는 아침에 빵을 먹어요.']],
    ['take', 'To swallow medicine.', ['감기약을 먹고 잤어요.']],
  ]],
  ['돕다', '동사', '초급', '', '돕따', ['도와', '도우니', '돕는'], [
    ['help; assist', 'To do something so that another person’s work becomes easier.', ['친구를 돕다.', '제가 도와 드릴게요.']],
  ]],
  ['듣다', '동사', '초급', '', '듣따', ['들어', '들으니', '듣는'], [
    ['hear; listen', 'To notice or pay attention to a sound with the ears.', ['음악을 듣다.', '매일 한국 노래를 들어요.']],
  ]],
  ['모르다', '동사', '초급', '', '모르다', ['몰라', '모르니', '모르는'], [
    ['not know', 'To have no knowledge or information about something.', ['답을 모르다.', '그 사람 이름을 몰라요.']],
  ]],
  ['살다', '동사', '초급', '', '살다', ['살아', '사니', '사는'], [
    ['live; reside', 'To have one’s home in a certain place.', ['서울에 살다.', '저는 부산에 살아요.']],
    ['live', 'To stay alive.', ['백 살까지 살다.']],
  ]],
  ['한국', '명사', '초급', '韓國', '한국', [], [
    ['Korea', 'A country in East Asia located on the Korean Peninsula.', ['한국 음식.', '내년에 한국에 가고 싶어요.']],
  ]],
  ['한국어', '명사', '초급', '韓國語', '한구거', [], [
    ['Korean; Korean language', 'The language spoken and written by Korean people.', ['한국어를 배우다.', '한국어 공부는 재미있어요.']],
  ]],
  ['공부', '명사', '초급', '工夫', '공부', [], [
    ['study; learning', 'The act of learning knowledge or skills.', ['공부 시간.', '시험 공부를 해야 해요.']],
  ]],
  ['공부하다', '동사', '초급', '工夫하다', '공부하다', ['공부하여', '공부해', '공부하니'], [
    ['study', 'To learn and gain knowledge or skills.', ['열심히 공부하다.', '도서관에서 공부해요.']],
  ]],
  ['학교', '명사', '초급', '學校', '학꾜', [], [
    ['school', 'A place where students are taught by teachers.', ['학교에 가다.', '우리 학교는 집에서 가까워요.']],
  ]],
  ['학생', '명사', '초급', '學生', '학쌩', [], [
    ['student', 'A person who learns at a school.', ['대학교 학생.']],
  ]],
  ['선생님', '명사', '초급', '先生님', '선생님', [], [
    ['teacher', 'A polite word for a person who teaches students.', ['한국어 선생님.']],
  ]],
  ['친구', '명사', '초급', '親舊', '친구', [], [
    ['friend', 'A person one is close to and spends time with.', ['친구를 만나다.', '주말에 친구하고 영화를 봤어요.']],
  ]],
  ['사람', '명사', '초급', '', '사람', [], [
    ['person; human', 'A human being.', ['좋은 사람.']],
  ]],
  ['사랑', '명사', '초급', '', '사랑', [], [
    ['love', 'A deep feeling of caring for and liking someone.', ['부모님의 사랑.']],
  ]],
  ['물', '명사', '초급', '', '물', [], [
    ['water', 'The clear liquid that people drink and that falls as rain.', ['물을 마시다.']],
  ]],
  ['밥', '명사', '초급', '', '밥', [], [
    ['rice; cooked rice', 'Rice cooked in water until soft.', ['밥을 짓다.']],
    ['meal', 'Food eaten at a regular time of day.', ['같이 밥 먹어요.']],
  ]],
  ['식사', '명사', '초급', '食事', '식싸', [], [
    ['meal', 'The act of eating food at a regular time, or the food itself.', ['식사 시간.']],
  ]],
  ['책', '명사', '초급', '冊', '책', [], [
    ['book', 'Pages of writing or pictures bound together.', ['책을 읽다.']],
  ]],
  ['집', '명사', '초급', '', '집', [], [
    ['house; home', 'A building where people live.', ['집에 가다.']],
  ]],
  ['시간', '명사', '초급', '時間', '시간', [], [
    ['time', 'The passing of moments from past to future.', ['시간이 없다.']],
    ['hour', 'A unit for counting periods of sixty minutes.', ['두 시간 동안 기다렸어요.']],
  ]],
  ['도서관', '명사', '초급', '圖書館', '도서관', [], [
    ['library', 'A building where books are kept for people to read or borrow.', ['도서관에서 책을 빌리다.']],
  ]],
  ['약속', '명사', '초급', '約束', '약쏙', [], [
    ['promise; appointment', 'An agreement with someone to do something or to meet.', ['약속을 지키다.']],
  ]],
  ['경험', '명사', '중급', '經驗', '경험', [], [
    ['experience', 'Something one has done or gone through oneself.', ['좋은 경험.']],
  ]],
  ['김치', '명사', '초급', '', '김치', [], [
    ['kimchi', 'A Korean side dish of salted and fermented vegetables such as napa cabbage.', ['김치를 담그다.']],
  ]],
  ['노래', '명사', '초급', '', '노래', [], [
    ['song', 'Music with words that is sung.', ['노래를 부르다.']],
  ]],
  ['가다', '동사', '초급', '', '가다', ['가', '가니', '가는'], [
    ['go', 'To move from one place to another.', ['학교에 가다.']],
  ]],
  ['오다', '동사', '초급', '', '오다', ['와', '오니', '오는'], [
    ['come', 'To move toward the speaker’s place.', ['집에 오다.']],
  ]],
  ['보다', '동사', '초급', '', '보다', ['봐', '보니', '보는'], [
    ['see; look; watch', 'To notice or look at something with the eyes.', ['영화를 보다.']],
  ]],
  ['주다', '동사', '초급', '', '주다', ['줘', '주니', '주는'], [
    ['give', 'To hand something over to another person.', ['선물을 주다.']],
  ]],
  ['마시다', '동사', '초급', '', '마시다', ['마셔', '마시니', '마시는'], [
    ['drink', 'To swallow a liquid.', ['커피를 마시다.']],
  ]],
  ['배우다', '동사', '초급', '', '배우다', ['배워', '배우니', '배우는'], [
    ['learn', 'To gain knowledge or a skill from someone or by practice.', ['태권도를 배우다.']],
  ]],
  ['쓰다', '동사', '초급', '', '쓰다', ['써', '쓰니', '쓰는'], [
    ['write', 'To put letters or words on paper or a screen.', ['편지를 쓰다.']],
  ]],
  ['하다', '동사', '초급', '', '하다', ['하여', '해', '하니'], [
    ['do', 'To carry out an action or activity.', ['숙제를 하다.']],
  ]],
  ['되다', '동사', '초급', '', '되다', ['되어', '돼', '되니'], [
    ['become', 'To change into a new state or position.', ['의사가 되다.']],
  ]],
  ['일하다', '동사', '초급', '', '일하다', ['일하여', '일해'], [
    ['work', 'To do a job, usually to earn money.', ['회사에서 일하다.']],
  ]],
  ['만나다', '동사', '초급', '', '만나다', ['만나', '만나니'], [
    ['meet', 'To come together with someone.', ['친구를 만나다.']],
  ]],
  ['부르다', '동사', '초급', '', '부르다', ['불러', '부르니'], [
    ['sing', 'To produce a song with the voice.', ['노래를 부르다.']],
    ['call', 'To say someone’s name to get their attention.', ['이름을 부르다.']],
  ]],
  ['걷다', '동사', '초급', '', '걷따', ['걸어', '걸으니', '걷는'], [
    ['walk', 'To move by putting one foot in front of the other.', ['공원을 걷다.']],
  ]],
  ['짓다', '동사', '중급', '', '짇따', ['지어', '지으니', '짓는'], [
    ['build; make', 'To make a building, rice, clothes or a name.', ['집을 짓다.']],
  ]],
  ['알다', '동사', '초급', '', '알다', ['알아', '아니', '아는'], [
    ['know', 'To have knowledge or information about something.', ['정답을 알다.']],
  ]],
  ['만들다', '동사', '초급', '', '만들다', ['만들어', '만드니', '만드는'], [
    ['make', 'To create something with effort or skill.', ['음식을 만들다.']],
  ]],
  ['사다', '동사', '초급', '', '사다', ['사', '사니', '사는'], [
    ['buy', 'To get something by paying money for it.', ['옷을 사다.']],
  ]],
  ['낫다', '동사', '중급', '', '낟따', ['나아', '나으니', '낫는'], [
    ['recover; get better', 'For an illness or wound to go away.', ['감기가 낫다.']],
  ]],
  ['감사하다', '동사', '초급', '感謝하다', '감사하다', ['감사하여', '감사해'], [
    ['thank; be grateful', 'To express gratitude for something.', ['도와주셔서 감사합니다.']],
  ]],
  ['춥다', '형용사', '초급', '', '춥따', ['추워', '추우니', '추운'], [
    ['cold', 'For the weather or air to have a low temperature.', ['겨울은 춥다.']],
  ]],
  ['덥다', '형용사', '초급', '', '덥따', ['더워', '더우니', '더운'], [
    ['hot', 'For the weather or air to have a high temperature.', ['여름은 덥다.']],
  ]],
  ['쉽다', '형용사', '초급', '', '쉽따', ['쉬워', '쉬우니', '쉬운'], [
    ['easy', 'Not difficult to do or understand.', ['문제가 쉽다.']],
  ]],
  ['어렵다', '형용사', '초급', '', '어렵따', ['어려워', '어려우니', '어려운'], [
    ['difficult; hard', 'Needing a lot of effort or skill.', ['시험이 어렵다.']],
  ]],
  ['좋다', '형용사', '초급', '', '조타', ['좋아', '좋으니', '좋은'], [
    ['good; nice', 'Having qualities that people like or want.', ['날씨가 좋다.']],
  ]],
  ['크다', '형용사', '초급', '', '크다', ['커', '크니', '큰'], [
    ['big; large', 'Greater than usual in size.', ['키가 크다.']],
  ]],
  ['바쁘다', '형용사', '초급', '', '바쁘다', ['바빠', '바쁘니', '바쁜'], [
    ['busy', 'Having a lot to do and little free time.', ['요즘 일이 바쁘다.']],
  ]],
  ['파랗다', '형용사', '중급', '', '파라타', ['파래', '파라니', '파란'], [
    ['blue', 'Having the color of a clear sky.', ['하늘이 파랗다.']],
  ]],
  ['하얗다', '형용사', '중급', '', '하야타', ['하얘', '하야니', '하얀'], [
    ['white', 'Having the color of snow.', ['눈이 하얗다.']],
  ]],
  ['그렇다', '형용사', '초급', '', '그러타', ['그래', '그러니', '그런'], [
    ['so; like that', 'Being in the state just mentioned.', ['정말 그래요?']],
  ]],
  ['푸르다', '형용사', '중급', '', '푸르다', ['푸르러', '푸르니', '푸른'], [
    ['blue; green', 'Having the color of a clear sky, the sea or fresh grass.', ['푸른 바다.']],
  ]],
];

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const feat = (att, val) => `<feat att="${esc(att)}" val="${esc(val)}"/>`;

/** Renders the starter rows as KRDict LMF XML (the shape of the "사전 전체 내려받기" export). */
export function renderKrdictStarterXml(rows = KRDICT_STARTER_ROWS) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<LexicalResource dtdVersion="16">',
    `<GlobalInformation>${feat('label', 'Flashcards hand-authored starter sample in KRDict LMF format')}</GlobalInformation>`,
    `<Lexicon>${feat('language', '한국어')}`,
  ];
  rows.forEach(([headword, pos, level, origin, pron, forms, senses], i) => {
    lines.push(`<LexicalEntry att="id" val="${i + 1}">`);
    lines.push(feat('homonym_number', '0'), feat('lexicalUnit', '단어'), feat('partOfSpeech', pos));
    lines.push(feat('vocabularyLevel', level));
    if (origin) lines.push(feat('origin', origin));
    lines.push(`<Lemma>${feat('writtenForm', headword)}</Lemma>`);
    lines.push(`<WordForm>${feat('type', '발음')}${feat('pronunciation', pron)}</WordForm>`);
    for (const f of forms)
      lines.push(`<WordForm>${feat('type', '활용')}${feat('writtenForm', f)}</WordForm>`);
    senses.forEach(([equivalent, definition, examples], j) => {
      lines.push(`<Sense att="id" val="${i + 1}-${j + 1}">`);
      lines.push(
        `<Equivalent>${feat('language', '영어')}${feat('lemma', equivalent)}${feat('definition', definition)}</Equivalent>`,
      );
      examples.forEach((ex) => {
        const type = /[.?!]$/.test(ex) && ex.split(' ').length > 2 ? '문장' : '구';
        lines.push(`<SenseExample>${feat('type', type)}${feat('example', ex)}</SenseExample>`);
      });
      lines.push('</Sense>');
    });
    lines.push('</LexicalEntry>');
  });
  lines.push('</Lexicon>', '</LexicalResource>', '');
  return lines.join('\n');
}
