import { describe, expect, it } from "vitest";
import { recipientFilter } from "./recipient-filter";

const saved = { botIds: ["11111111-1111-4111-8111-111111111111"] };

describe("получатели черновика рассылки", () => {
  it("первое открытие черновика — сохранённый фильтр", () => {
    expect(recipientFilter({}, saved).filter.botIds).toEqual(saved.botIds);
  });

  it("фильтр из адреса главнее сохранённого", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    expect(recipientFilter({ bot: other }, saved).filter.botIds).toEqual([other]);
  });

  it("явно выбранные «все» не возвращают сохранённое ограничение", () => {
    expect(recipientFilter({ all: "1" }, saved).filter.botIds ?? []).toEqual([]);
  });

  it("новая рассылка без адреса — вся база", () => {
    expect(recipientFilter({}, null).filter.botIds ?? []).toEqual([]);
  });

  it("испорченный фильтр в адресе не становится всей базой: остаётся сохранённый, отправка закрыта", () => {
    const broken = { fields: JSON.stringify([{ fieldId: "33333333-3333-4333-8333-333333333333", kind: "number", min: 100, max: 10 }]) };
    const result = recipientFilter(broken, saved);
    expect(result.filter.botIds).toEqual(saved.botIds);
    expect(result.broken).toBe(true);
    expect(result.error).toBeTruthy();
    expect(recipientFilter(broken, null).broken).toBe(true);
    expect(recipientFilter({ bot: saved.botIds[0] }, null).broken).toBe(false);
  });
});
