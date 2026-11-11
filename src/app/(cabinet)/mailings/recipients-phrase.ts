/** «1 человеку», «21 человеку», «5 людям». */
export function peopleCountPhrase(count: number): string {
  const one = count % 10 === 1 && count % 100 !== 11;
  return `${count} ${one ? "человеку" : "людям"}`;
}

/** Сколько людей получат рассылку — словами, рядом с кнопкой «Отправить сейчас». */
export function recipientsPhrase(count: number): string {
  if (count === 0) return "Получателей нет";
  return `Уйдёт ${peopleCountPhrase(count)}`;
}
