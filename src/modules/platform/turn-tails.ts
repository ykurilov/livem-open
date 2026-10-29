import type { StepContext } from "@ykurilov/agent-chat-core";

/** Сколько чатов помнить: у каждого хвост последнего хода. Хвост нужен только пока идёт ход. */
const TAILS_IN_MEMORY = 1000;

/**
 * Хвост хода для модели (этап, день, отсчёт сообщений, пометки): приложение кладёт его перед ходом, а
 * `agent.stepContext` отдаёт в самый конец запроса каждого шага. В историю хвост не пишется: начало запроса от хода
 * к ходу то же, кэш модели цел. Ход идёт в том же процессе, что его начал, поэтому хватает памяти процесса.
 */
export interface TurnTails {
  /** Хвост следующего хода чата; `null` или пустая строка — ход без хвоста. */
  set(chatId: string, tail: string | null): void;
  stepContext: StepContext;
}

export function createTurnTails(limit = TAILS_IN_MEMORY): TurnTails {
  const tails = new Map<string, string>();
  return {
    set(chatId, tail) {
      tails.delete(chatId);
      if (!tail) return;
      tails.set(chatId, tail);
      if (tails.size > limit) tails.delete(tails.keys().next().value!);
    },
    stepContext: ({ chatId }) => tails.get(chatId) ?? null,
  };
}
