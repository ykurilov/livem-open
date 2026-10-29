import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { describe, expect, it } from "vitest";
import { newLeadMagnetSettings } from "../lead-magnets/settings";
import { hasUnsavedFlowEdit, keepBoardLayout } from "./board-draft";

const saved = (): AgentFlow => structuredClone(newLeadMagnetSettings("Разбор").flow);

/** Тот же объект с ключами в обратном порядке: так сценарий приходит из jsonb базы. */
function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversedKeys) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedKeys(item)])) as T;
  return value;
}

describe("hasUnsavedFlowEdit", () => {
  it("тот же сценарий с другим порядком ключей — правки нет (Дмитрий 15.10: доска «Сохранено», а конструктор закрыт)", () => {
    expect(hasUnsavedFlowEdit(reversedKeys(saved()), saved())).toBe(false);
  });

  it("перестановка карточек на доске — не правка: конструктор не закрывается", () => {
    const board = saved();
    board.layout = { ...board.layout, [board.states[0]!.id]: { x: 420, y: 180 } };
    expect(hasUnsavedFlowEdit(board, saved())).toBe(false);
  });

  it("правка текста ноды — правка", () => {
    const board = saved();
    board.states[0]!.instructions += " И ещё одно правило.";
    expect(hasUnsavedFlowEdit(board, saved())).toBe(true);
  });
});

describe("keepBoardLayout", () => {
  it("новая версия черновика берёт положение карточек с доски для нод, которые остались; новые ноды — как в версии", () => {
    const board = saved();
    const stateId = board.states[0]!.id;
    board.layout = { [stateId]: { x: 420, y: 180 }, gone: { x: 1, y: 1 } };
    const next = saved();
    next.layout = { [stateId]: { x: 0, y: 0 }, fresh: { x: 5, y: 5 } };
    expect(keepBoardLayout(next, board).layout).toEqual({ [stateId]: { x: 420, y: 180 }, fresh: { x: 5, y: 5 } });
  });
});
