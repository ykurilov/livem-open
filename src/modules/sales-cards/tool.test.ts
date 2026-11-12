import { describe, expect, it } from "vitest";
import type { AppStateAccess } from "@ykurilov/agent-chat-core";
import { createSalesCardTool, SALES_CARD_TOOL } from "./tool";
import { doubtCard, priceCard, settingsWithCards } from "./test-settings";

/** Состояние ветки чата, как его даёт ядро инструментам. */
function branchState(): AppStateAccess & { values: Record<string, unknown> } {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: (path?: string) => (path ? structuredClone(path.split(".").reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], values)) : structuredClone(values)),
    set(path, value) {
      const keys = path.split(".");
      let at = values;
      for (const key of keys.slice(0, -1)) at = (at[key] ??= {}) as Record<string, unknown>;
      at[keys.at(-1)!] = structuredClone(value);
    },
    unset(path) {
      delete values[path];
    },
  };
}

const call = (tool: ReturnType<typeof createSalesCardTool>, id: string) =>
  tool.execute!({ id }, { toolCallId: "call", messages: [] } as never) as Promise<Record<string, unknown>>;

describe(`инструмент ${SALES_CARD_TOOL}`, () => {
  const settings = settingsWithCards([priceCard, doubtCard]);

  it("отдаёт полный текст и как его использовать: «дословно» — как есть", async () => {
    const answer = await call(createSalesCardTool(settings, branchState()), priceCard.id);
    expect(answer).toMatchObject({ ok: true, text: priceCard.text });
    expect(String(answer.use)).toMatch(/дословно/);
  });

  it("«своими словами» — пересказ под разговор", async () => {
    const answer = await call(createSalesCardTool(settings, branchState()), doubtCard.id);
    expect(answer).toMatchObject({ ok: true, text: doubtCard.text });
    expect(String(answer.use)).toMatch(/своими словами/);
  });

  it("одна заготовка — не больше раза за разговор: повторный запрос говорит, что она уже использована", async () => {
    const state = branchState();
    await call(createSalesCardTool(settings, state), priceCard.id);
    // Следующий ход — новый набор инструментов, состояние ветки то же
    const again = await call(createSalesCardTool(settings, state), priceCard.id);
    expect(again).toMatchObject({ ok: false });
    expect(String(again.error)).toMatch(/уже/);
    expect(again).not.toHaveProperty("text");
  });

  it("другая заготовка после первой выдаётся", async () => {
    const state = branchState();
    await call(createSalesCardTool(settings, state), priceCard.id);
    expect(await call(createSalesCardTool(settings, state), doubtCard.id)).toMatchObject({ ok: true });
  });

  it("неизвестный id — ошибка модели, не исключение", async () => {
    const answer = await call(createSalesCardTool(settings, branchState()), "nope");
    expect(answer).toMatchObject({ ok: false });
  });

  it("описание не меняется от хода к ходу и не содержит текстов заготовок", () => {
    const first = createSalesCardTool(settings, branchState());
    const second = createSalesCardTool(settings, branchState());
    expect(first.description).toBe(second.description);
    expect(first.description).not.toContain(priceCard.text);
    expect(first.description).not.toContain(priceCard.title);
  });
});
