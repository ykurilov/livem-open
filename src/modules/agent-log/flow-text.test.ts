import { describe, expect, it } from "vitest";
import { firstMessageLines, migrationText, transitionText } from "./flow-text";
import type { ChatMigrationEntry, FlowTransitionEntry } from "./types";

const base: FlowTransitionEntry = { kind: "transition", at: "2026-10-15T06:00:00Z", durationMs: 0, from: "Знакомство", to: "Доработка", decidedBy: "claim", reason: null };

describe("переход в «Логе» словами", () => {
  it("агент с судьёй: уверенность судьи через запятую, объяснение агента, день", () => {
    expect(transitionText({ ...base, probability: 0.91, reason: "Идея названа: кофейня", day: 2, totalDays: 3 })).toEqual({
      route: "Знакомство → Доработка",
      decider: "агент + судья 0,91",
      reason: "Идея названа: кофейня",
      day: "День 2 из 3",
    });
  });

  it("судья после ответа, таймер, данные и событие — по-разному", () => {
    expect(transitionText({ ...base, decidedBy: "judge" }).decider).toBe("судья после ответа");
    expect(transitionText({ ...base, decidedBy: "timer", reason: "нода длится 1 день" })).toMatchObject({ decider: "таймер", reason: "нода длится 1 день" });
    expect(transitionText({ ...base, decidedBy: "data" }).decider).toBe("по данным из карточки");
    expect(transitionText({ ...base, decidedBy: "event" }).decider).toBe("событие");
  });

  it("без причины и без дня — пустые поля, а не выдумка", () => {
    const text = transitionText(base);
    expect(text.reason).toBeNull();
    expect(text.day).toBeNull();
  });

  it("день без срока — «День 2»; возврат из попутного помечен", () => {
    expect(transitionText({ ...base, day: 2 }).day).toBe("День 2");
    expect(transitionText({ ...base, returned: true }).route).toBe("Знакомство → Доработка (возврат)");
  });

  it("вероятность судьи — с двумя знаками", () => {
    expect(transitionText({ ...base, probability: 1 }).decider).toBe("агент + судья 1,00");
  });
});

describe("почему бот написал первым", () => {
  it("каждая причина — одна понятная строка", () => {
    expect(
      firstMessageLines([
        { kind: "silence", step: 2 },
        { kind: "morning" },
        { kind: "transition", stateTitle: "Доработка" },
        { kind: "daily", at: "18:00" },
        { kind: "night_messages", count: 1 },
        { kind: "night_messages", count: 3 },
        { kind: "night_messages", count: 5 },
        { kind: "farewell" },
      ]),
    ).toEqual([
      "Человек молчал: второе касание",
      "Утреннее сообщение нового дня",
      "Переход по сроку: в ноду «Доработка»",
      "Касание по часам, 18:00",
      "Ответ на 1 сообщение, оставшееся без ответа",
      "Ответ на 3 сообщения, оставшиеся без ответа",
      "Ответ на 5 сообщений, оставшихся без ответа",
      "Прощание: срок вышел",
    ]);
  });

  it("номер касания — число, если порядковое слово не нашлось", () => {
    expect(firstMessageLines([{ kind: "silence", step: 7 }])).toEqual(["Человек молчал: касание 7"]);
  });
});

describe("перевод разговоров на новую версию", () => {
  const entry = (moves: ChatMigrationEntry["moves"]): ChatMigrationEntry => ({
    kind: "migration",
    at: "2026-10-15T09:00:00Z",
    durationMs: 0,
    by: "Дмитрий (expert@example.com)",
    chats: moves.reduce((sum, move) => sum + move.chats, 0),
    toVersionId: "v3",
    toVersionAt: "2026-10-15T08:30:00Z",
    moves,
  });

  it("кто, сколько, с какой версии на какую, из каких нод в какие; время — по Москве", () => {
    const text = migrationText(
      entry([
        { fromVersionId: "v1", fromVersionAt: "2026-10-14T09:00:00Z", from: "Сборка", to: "Сборка", chats: 3 },
        { fromVersionId: "v1", fromVersionAt: "2026-10-14T09:00:00Z", from: "Доработка", to: "Сборка", chats: 1 },
      ]),
    );
    expect(text).toEqual({
      title: "Перевод на новую версию: 4 разговора",
      by: "Дмитрий (expert@example.com)",
      versions: "Версия от 14.10, 12:00 → версия от 15.10, 11:30",
      moves: ["«Сборка» → «Сборка»: 3 разговора", "«Доработка» → «Сборка»: 1 разговор"],
    });
  });

  it("с нескольких прежних версий — версия у каждой строки", () => {
    const text = migrationText(
      entry([
        { fromVersionId: "v1", fromVersionAt: "2026-10-13T09:00:00Z", from: "Сборка", to: "Сборка", chats: 5 },
        { fromVersionId: "v2", fromVersionAt: "2026-10-14T09:00:00Z", from: "Сборка", to: "Сборка", chats: 11 },
      ]),
    );
    expect(text.versions).toBe("Версия от 13.10, 12:00, версия от 14.10, 12:00 → версия от 15.10, 11:30");
    expect(text.moves).toEqual(["версия от 13.10, 12:00: «Сборка» → «Сборка»: 5 разговоров", "версия от 14.10, 12:00: «Сборка» → «Сборка»: 11 разговоров"]);
  });
});
