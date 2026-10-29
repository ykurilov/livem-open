import { describe, expect, it } from "vitest";
import { moneyOf, parseGetCourseNotice, sameSecret } from "./getcourse";

describe("parseGetCourseNotice", () => {
  it("уведомление об оплате: заказ, сумма и валюта, почта строчными, метки", () => {
    expect(
      parseGetCourseNotice({
        event: "order_paid",
        id: "123456",
        number: "4711",
        status: "Завершён",
        cost: "2 990 руб.",
        email: " Anna@Mail.RU ",
        user_id: "999",
        offer: "Свой ИИ-агент — Основной",
        utm_source: "vasily",
        utm_medium: "telegram",
        utm_campaign: "ai_agent_course",
        utm_content: "k7m2p9qa",
        utm_term: "",
      }),
    ).toEqual({
      externalOrderId: "123456",
      orderNumber: "4711",
      status: "Завершён",
      kind: "paid",
      amount: 2990,
      currency: "RUB",
      email: "anna@mail.ru",
      externalUserId: "999",
      offerTitle: "Свой ИИ-агент — Основной",
      utm: { source: "vasily", medium: "telegram", campaign: "ai_agent_course", content: "k7m2p9qa", term: null },
    });
  });

  it("незаполненные переменные GetCourse («{object.utm_content}») — пусто; заказ создан — не оплачен", () => {
    const notice = parseGetCourseNotice({ event: "order_created", id: 77, status: "Новый", cost: "1990", utm_content: "{object.utm_content}", email: "{object.user.email}" });
    expect(notice).toMatchObject({ externalOrderId: "77", kind: "open", amount: 1990, currency: null, email: null, utm: { content: null } });
  });

  it("оплата без события — только однозначный статус завершения; вложенный user", () => {
    expect(parseGetCourseNotice({ id: "5", status: "Завершён", user: { id: 1, email: "b@b.ru" } })).toMatchObject({ kind: "paid", email: "b@b.ru", externalUserId: "1" });
    for (const status of ["Завершен", "Оплачен", "completed", "Paid"]) expect(parseGetCourseNotice({ id: "5", status })).toMatchObject({ kind: "paid" });
  });

  it("«не завершён», «незавершён», incomplete, частичная оплата, ожидание — не оплата", () => {
    for (const status of [
      "Не завершён",
      "Незавершён",
      "не завершен",
      "Incomplete",
      "not completed",
      "Не оплачен",
      "Частично оплачен",
      "Ожидаем оплаты",
      "В работе",
      "Новый",
      "Завершён частично",
      "unpaid",
    ])
      expect(parseGetCourseNotice({ id: "7", status }), status).toMatchObject({ kind: "open" });
  });

  it("возврат и отмена — отдельный вид, событие order_refunded тоже", () => {
    for (const status of ["Возврат", "Возвращён", "Отменён", "Отменен", "refunded", "cancelled", "Canceled"])
      expect(parseGetCourseNotice({ id: "8", status }), status).toMatchObject({ kind: "refunded" });
    expect(parseGetCourseNotice({ id: "8", event: "order_refunded", status: "Завершён" })).toMatchObject({ kind: "refunded" });
  });

  it("сумма из запасных полей; валюта отдельным полем или из стоимости с валютой", () => {
    expect(parseGetCourseNotice({ id: "9", cost_money_value: "1 299,00", currency: "usd" })).toMatchObject({ amount: 1299, currency: "USD" });
    expect(parseGetCourseNotice({ id: "9", cost: "{object.cost_money_value}", cost_money: "1 990 руб." })).toMatchObject({ amount: 1990, currency: "RUB" });
  });

  it("длинные поля обрезаются", () => {
    const notice = parseGetCourseNotice({ id: "10", status: "x".repeat(5000), offer: "о".repeat(5000), utm_content: "c".repeat(500) })!;
    expect(notice.status.length).toBeLessThanOrEqual(200);
    expect(notice.offerTitle!.length).toBeLessThanOrEqual(500);
    expect(notice.utm.content!.length).toBeLessThanOrEqual(200);
  });

  it("без номера заказа — не заказ", () => {
    expect(parseGetCourseNotice({ status: "Завершён" })).toBeNull();
    expect(parseGetCourseNotice("строка")).toBeNull();
  });
});

describe("moneyOf", () => {
  it.each([
    ["2 990 руб.", 2990, "RUB"],
    ["1 299,00", 1299, null],
    ["1 299,50 ₽", 1299.5, "RUB"],
    ["$1,299.00", 1299, "USD"],
    ["1.299,00 €", 1299, "EUR"],
    ["0.00", 0, null],
    ["1990", 1990, null],
    ["12,5", 12.5, null],
    ["5 000 KZT", 5000, "KZT"],
  ])("%s → %s %s", (text, amount, currency) => {
    expect(moneyOf(text)).toEqual({ amount, currency });
  });

  it("не число и слишком большое — без суммы", () => {
    expect(moneyOf("бесплатно")).toEqual({ amount: null, currency: null });
    expect(moneyOf("99999999999999")).toEqual({ amount: null, currency: null });
    expect(moneyOf("1.2.3")).toEqual({ amount: null, currency: null });
  });
});

describe("sameSecret", () => {
  it("равные — да, разные и пустые — нет", () => {
    expect(sameSecret("abc123", "abc123")).toBe(true);
    expect(sameSecret("abc124", "abc123")).toBe(false);
    expect(sameSecret("abc", "abc123")).toBe(false);
    expect(sameSecret("", "")).toBe(false);
  });
});
