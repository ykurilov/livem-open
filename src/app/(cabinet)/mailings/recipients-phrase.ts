/** Сколько людей получат рассылку — словами, рядом с кнопкой «Отправить сейчас». */
export function recipientsPhrase(count: number): string {
  if (count === 0) return "Получателей нет";
  const one = count % 10 === 1 && count % 100 !== 11;
  return `Уйдёт ${count} ${one ? "человеку" : "людям"}`;
}
