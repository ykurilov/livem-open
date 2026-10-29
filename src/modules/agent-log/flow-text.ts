import type { ChatMigrationEntry, FirstMessageReason, FlowTransitionEntry } from "./types";

const DECIDER_LABEL: Record<FlowTransitionEntry["decidedBy"], string> = {
  claim: "агент + судья",
  judge: "судья после ответа",
  data: "по данным из карточки",
  event: "событие",
  timer: "таймер",
};

/** Уверенность судьи: «0,91». */
function probabilityText(probability: number): string {
  return probability.toFixed(2).replace(".", ",");
}

export interface TransitionText {
  route: string;
  /** Кто решил: «агент + судья 0,91», «таймер». */
  decider: string;
  /** Причина словами; нет — `null`. */
  reason: string | null;
  /** «День 2 из 3»; сценарий без дней — `null`. */
  day: string | null;
}

/** Переход «Лога» в четыре строки для эксперта: откуда → куда, кто решил, почему, какой день. */
export function transitionText(entry: FlowTransitionEntry): TransitionText {
  const decider =
    entry.decidedBy === "claim" && entry.probability !== undefined
      ? `${DECIDER_LABEL.claim} ${probabilityText(entry.probability)}`
      : DECIDER_LABEL[entry.decidedBy];
  return {
    route: `${entry.from} → ${entry.to}${entry.returned ? " (возврат)" : ""}`,
    decider,
    reason: entry.reason?.trim() || null,
    day: entry.day === undefined ? null : entry.totalDays === undefined ? `День ${entry.day}` : `День ${entry.day} из ${entry.totalDays}`,
  };
}

const ORDINAL = ["", "первое", "второе", "третье", "четвёртое", "пятое"];

function unansweredText(count: number): string {
  const last = count % 10;
  const teen = count % 100 >= 11 && count % 100 <= 14;
  if (last === 1 && !teen) return `Ответ на ${count} сообщение, оставшееся без ответа`;
  if (last >= 2 && last <= 4 && !teen) return `Ответ на ${count} сообщения, оставшиеся без ответа`;
  return `Ответ на ${count} сообщений, оставшихся без ответа`;
}

/** Причины, по которым бот написал первым, — по строке на причину. */
export function firstMessageLines(reasons: FirstMessageReason[]): string[] {
  return reasons.map((reason) => {
    switch (reason.kind) {
      case "silence":
        return ORDINAL[reason.step] ? `Человек молчал: ${ORDINAL[reason.step]} касание` : `Человек молчал: касание ${reason.step}`;
      case "morning":
        return "Утреннее сообщение нового дня";
      case "transition":
        return `Переход по сроку: в ноду «${reason.stateTitle}»`;
      case "daily":
        return `Касание по часам, ${reason.at}`;
      case "night_messages":
        return unansweredText(reason.count);
      case "farewell":
        return "Прощание: срок вышел";
    }
  });
}

/** «1 разговор», «3 разговора», «5 разговоров». */
export function chatsText(count: number): string {
  const last = count % 10;
  const teen = count % 100 >= 11 && count % 100 <= 14;
  if (last === 1 && !teen) return `${count} разговор`;
  if (last >= 2 && last <= 4 && !teen) return `${count} разговора`;
  return `${count} разговоров`;
}

const versionFormat = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });

/** Версия лидмагнита словами: «версия от 14.10, 12:00» (по Москве, как весь «Лог»). */
export const versionText = (at: string | Date) => `версия от ${versionFormat.format(new Date(at))}`;

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export interface MigrationText {
  title: string;
  by: string;
  versions: string;
  /** Откуда и куда: «Доработка» → «Сборка»: 1 разговор. С версией, если прежних версий несколько. */
  moves: string[];
}

/** Перевод разговоров для «Лога»: сколько, кто, с каких версий на какую, из каких нод в какие. */
export function migrationText(entry: ChatMigrationEntry): MigrationText {
  const fromVersions = [...new Map(entry.moves.map((move) => [move.fromVersionId, move.fromVersionAt])).values()];
  const several = fromVersions.length > 1;
  return {
    title: `Перевод на новую версию: ${chatsText(entry.chats)}`,
    by: entry.by,
    versions: capitalized(`${fromVersions.map(versionText).join(", ")} → ${versionText(entry.toVersionAt)}`),
    moves: entry.moves.map(
      (move) => `${several ? `${versionText(move.fromVersionAt)}: ` : ""}«${move.from}» → «${move.to}»: ${chatsText(move.chats)}`,
    ),
  };
}
