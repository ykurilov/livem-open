import { describe, expect, it } from "vitest";
import { mailingHeadline, mailingStatusBadge } from "./status-labels";

describe("mailingStatusBadge", () => {
  it("законченная рассылка, не ушедшая ни одному человеку (получателей не нашлось или всем «не доставлено»), — «Никому не ушла», не зелёная", () => {
    expect(mailingStatusBadge({ status: "done", sentCount: 0 })).toEqual({ label: "Никому не ушла", variant: "warm" });
  });

  it("отправленная хоть кому-то — «Отправлена»", () => {
    expect(mailingStatusBadge({ status: "done", sentCount: 1 })).toEqual({ label: "Отправлена", variant: "success" });
  });

  it("черновик, запланированная и идущая с нулём ушедших — как обычно: отправка ещё не закончилась", () => {
    expect(mailingStatusBadge({ status: "draft", sentCount: 0 }).label).toBe("Черновик");
    expect(mailingStatusBadge({ status: "scheduled", sentCount: 0 }).label).toBe("Запланирована");
    expect(mailingStatusBadge({ status: "sending", sentCount: 0 }).label).toBe("Отправляется");
  });
});

describe("mailingHeadline", () => {
  const now = new Date("2026-11-09T14:50:00Z");
  const later = new Date("2026-11-09T15:52:00Z");

  it("«Отправить сейчас»: время наступило, работник ещё не взял — «Отправляется», отменить уже не обещаем, страница следит сама", () => {
    expect(mailingHeadline({ status: "scheduled", scheduledAt: now, startedAt: null, sentCount: 0 }, now)).toEqual({
      badge: { label: "Отправляется", variant: "cool" },
      title: "Отправка начинается",
      canCancel: false,
      live: true,
    });
  });

  it("запланированная на будущее — когда уйдёт и что до тех пор её можно отменить", () => {
    const headline = mailingHeadline({ status: "scheduled", scheduledAt: later, startedAt: null, sentCount: 0 }, now);
    expect(headline).toMatchObject({ badge: { label: "Запланирована" }, title: "Уйдёт 9 нояб., 18:52 по Москве", canCancel: true, live: false });
  });

  it("идущая — с какого времени, страница следит сама; законченная — без слежения", () => {
    expect(mailingHeadline({ status: "sending", scheduledAt: now, startedAt: now, sentCount: 1 }, now)).toMatchObject({
      badge: { label: "Отправляется" },
      title: "Началась 9 нояб., 17:50 по Москве",
      live: true,
    });
    expect(mailingHeadline({ status: "done", scheduledAt: now, startedAt: now, sentCount: 1 }, now)).toMatchObject({ badge: { label: "Отправлена" }, live: false, canCancel: false });
    expect(mailingHeadline({ status: "cancelled", scheduledAt: later, startedAt: null, sentCount: 0 }, now)).toMatchObject({ title: "Не отправлялась", live: false });
  });
});
