import { describe, expect, it } from "vitest";
import { reminderNotice } from "./reactions";
import { purchaseTailLine } from "./tail";

const base = { purchased: false, unpaidOrder: false, promised: true, productTitle: "Свой ИИ-агент" };

describe("строка оплаты в хвосте хода", () => {
  it("обычный ход после обещания: сам об оплате не напоминай", () => {
    expect(purchaseTailLine(base)).toMatch(/сам об оплате не напоминай/);
    expect(purchaseTailLine({ ...base, promised: false, unpaidOrder: true })).toMatch(/сам об оплате не напоминай/);
  });

  it("ход самого напоминания: явное «в этом сообщении можно ссылку на оплату», без «сам не напоминай» — противоречия нет (ревью 21.10)", () => {
    for (const state of [base, { ...base, promised: false, unpaidOrder: true }]) {
      const line = purchaseTailLine({ ...state, remindingNow: true })!;
      expect(line).toMatch(/в этом сообщении можно ссылку на оплату/);
      expect(line).not.toMatch(/не напоминай/);
    }
    expect(purchaseTailLine({ ...base, purchased: true, remindingNow: true })).toMatch(/не продавай/);
  });

  it("служебное сообщение напоминания тоже прямо разрешает ссылку в этом сообщении", () => {
    expect(reminderNotice({ url: "https://school.example.com/ai_agent_course", title: "Свой ИИ-агент", campaign: "ai_agent_course" })).toMatch(/в этом сообщении можно ссылку на оплату/);
  });
});
