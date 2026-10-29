import { describe, expect, it } from "vitest";
import { formatUsd, parseSpendingSettings } from "./settings-form";

const form = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
const filled = { dailyLimitUsd: "1", monthlyBudgetUsd: "50", privacyPolicyUrl: "https://example.com/privacy", alertChatId: "-1001234" };

describe("форма настроек денег", () => {
  it("читает заполненную форму; запятая в сумме — тоже разделитель; суммы — как в базе, 6 знаков", () => {
    expect(parseSpendingSettings(form({ ...filled, dailyLimitUsd: "1,5" }))).toEqual({
      ok: true,
      changes: {
        dailyLimitUsd: "1.500000",
        monthlyBudgetUsd: "50.000000",
        privacyPolicyUrl: "https://example.com/privacy",
        alertChatId: "-1001234",
      },
    });
  });

  it("лишние знаки после запятой округляются до 6", () => {
    const parsed = parseSpendingSettings(form({ ...filled, dailyLimitUsd: "1.23456789", monthlyBudgetUsd: "0.0100004" }));
    expect(parsed).toMatchObject({ ok: true, changes: { dailyLimitUsd: "1.234568", monthlyBudgetUsd: "0.010000" } });
  });

  it("пустые бюджет, политика и адресат тревог — не заданы", () => {
    const parsed = parseSpendingSettings(form({ dailyLimitUsd: "2", monthlyBudgetUsd: " ", privacyPolicyUrl: "", alertChatId: "" }));
    expect(parsed).toEqual({ ok: true, changes: { dailyLimitUsd: "2.000000", monthlyBudgetUsd: null, privacyPolicyUrl: null, alertChatId: null } });
  });

  it("границы: от $0.01 до суммы меньше миллиона", () => {
    expect(parseSpendingSettings(form({ ...filled, dailyLimitUsd: "0.01", monthlyBudgetUsd: "999999.99" }))).toMatchObject({
      ok: true,
      changes: { dailyLimitUsd: "0.010000", monthlyBudgetUsd: "999999.990000" },
    });
  });

  it.each([
    [{ dailyLimitUsd: "" }, /дневной лимит/i],
    [{ dailyLimitUsd: "0" }, /дневной лимит/i],
    [{ dailyLimitUsd: "abc" }, /дневной лимит/i],
    [{ dailyLimitUsd: "0.0000001" }, /дневной лимит.*0\.01/i],
    [{ dailyLimitUsd: "0.009" }, /дневной лимит/i],
    [{ dailyLimitUsd: "1e-7" }, /дневной лимит/i],
    [{ dailyLimitUsd: "-1" }, /дневной лимит/i],
    [{ dailyLimitUsd: "99999999999999" }, /дневной лимит.*1 000 000/i],
    [{ dailyLimitUsd: "1000000" }, /дневной лимит/i],
    [{ monthlyBudgetUsd: "-5" }, /бюджет/i],
    [{ monthlyBudgetUsd: "1e3" }, /бюджет/i],
    [{ monthlyBudgetUsd: "99999999999999" }, /бюджет/i],
    [{ monthlyBudgetUsd: "0.001" }, /бюджет/i],
    [{ privacyPolicyUrl: "example.com" }, /политик/i],
    [{ privacyPolicyUrl: "javascript:alert(1)" }, /политик/i],
    [{ alertChatId: "мой чат" }, /тревог/i],
  ])("ошибка с понятным текстом: %o", (change, error) => {
    const parsed = parseSpendingSettings(form({ ...filled, ...change }));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(error);
  });

  it("доллары: центы, у малых сумм — доли цента", () => {
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(0.0423)).toBe("$0.042");
    expect(formatUsd(0)).toBe("$0.00");
  });
});
