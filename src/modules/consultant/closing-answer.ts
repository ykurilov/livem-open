/** Доля слов куска, найденных в прощании, начиная с которой кусок считается пересказом прощания. */
const REPEAT_SHARE = 0.5;
/**
 * Пересказ — только с длинным совпадением: столько слов подряд, как в прощании («напишет вам здесь»).
 * Общие слова вразброс — не пересказ: «Дату первой встречи… уточнит Дмитрий» при прощании «До встречи на первой встрече!».
 */
const MIN_SHARED_RUN = 3;
const THANKS = /^(спасибо|благодарю)/i;

/** Слово до четырёх букв: «коуч» и «коучу», «напишет» и «напишу» совпадают. */
function stemsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-zа-яё]{3,}/g) ?? []).map((word) => word.slice(0, 4));
}

/**
 * Ответ на вопрос перед прощанием приложения — без того, что прощание и так скажет.
 * Выкидывает благодарности и куски фраз (между тире), которые пересказывают прощание: кто, как и когда свяжется.
 */
export function answerWithoutFarewellRepeats(answer: string, farewell: string): string {
  const farewellOrder = stemsOf(farewell);
  const farewellStems = new Set(farewellOrder);
  const farewellPairs = new Set(farewellOrder.slice(1).map((stem, index) => `${farewellOrder[index]} ${stem}`));
  const repeatsFarewell = (piece: string) => {
    const stems = stemsOf(piece);
    const shared = stems.filter((stem) => farewellStems.has(stem)).length;
    return longestSharedRun(stems, farewellPairs) >= MIN_SHARED_RUN && shared / stems.length >= REPEAT_SHARE;
  };
  const sentences = answer.trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
  return sentences
    .map((sentence) => {
      if (THANKS.test(sentence)) return "";
      const ending = sentence.match(/[.!?…]+$/)?.[0] ?? ".";
      const pieces = sentence.replace(/[.!?…]+$/, "").split(/\s+[—–-]\s+/);
      const kept = pieces.filter((piece) => !repeatsFarewell(piece));
      // Без начала фразы остаток со строчной буквы — обрывок («уточнит сама.»): уходит вся фраза
      if (kept[0] !== pieces[0] && /^[a-zа-яё]/.test(kept[0] ?? "")) return "";
      return kept.length > 0 ? `${kept.join(" — ")}${ending}` : "";
    })
    .filter(Boolean)
    .join(" ");
}

/** Сколько слов куска подряд идут так же подряд в прощании. */
function longestSharedRun(stems: string[], farewellPairs: Set<string>): number {
  let longest = 0;
  let run = 1;
  for (let index = 1; index < stems.length; index++) {
    run = farewellPairs.has(`${stems[index - 1]} ${stems[index]}`) ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return longest > 1 ? longest : 0;
}
