// Сообщение без кода от человека без идущего разговора: новичок, брошенный недавно разговор или «Входящие»
import { describe, expect, it } from "vitest";
import { REOPEN_WINDOW_MS, whoWritesWithoutCode } from "./returning";

const NOW = new Date("2026-10-19T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY = 24 * 60 * 60_000;

describe("сообщение без кода без идущего разговора", () => {
  it("окно продолжения брошенного разговора — 7 дней", () => {
    expect(REOPEN_WINDOW_MS).toBe(7 * DAY);
  });

  it("ни прохождений, ни рассылок — новичок", () => {
    expect(whoWritesWithoutCode({ lastPassage: null, lastMailingSentAt: null, staffReplied: false, now: NOW })).toEqual({ kind: "newcomer" });
  });

  it("прохождений не было, но уходила рассылка — не новичок, во «Входящие»", () => {
    expect(whoWritesWithoutCode({ lastPassage: null, lastMailingSentAt: ago(30 * DAY), staffReplied: false, now: NOW })).toEqual({ kind: "inbox" });
  });

  it("прохождений и рассылок не было, но эксперт отвечал из «Входящих» — не новичок", () => {
    expect(whoWritesWithoutCode({ lastPassage: null, lastMailingSentAt: null, staffReplied: true, now: NOW })).toEqual({ kind: "inbox" });
  });

  it("брошен меньше 7 дней назад — продолжить тот же разговор", () => {
    const lastPassage = { id: "p1", status: "not_completed" as const, lastActivityAt: ago(7 * DAY - 1) };
    expect(whoWritesWithoutCode({ lastPassage, lastMailingSentAt: null, staffReplied: false, now: NOW })).toEqual({ kind: "reopen", passageId: "p1" });
  });

  it("брошен ровно 7 дней назад и раньше — во «Входящие»", () => {
    for (const age of [7 * DAY, 90 * DAY]) {
      const lastPassage = { id: "p1", status: "not_completed" as const, lastActivityAt: ago(age) };
      expect(whoWritesWithoutCode({ lastPassage, lastMailingSentAt: null, staffReplied: false, now: NOW })).toEqual({ kind: "inbox" });
    }
  });

  it("брошен недавно, но после разговора ушла рассылка — во «Входящие» (человек отвечает на рассылку)", () => {
    const lastPassage = { id: "p1", status: "not_completed" as const, lastActivityAt: ago(3 * DAY) };
    expect(whoWritesWithoutCode({ lastPassage, lastMailingSentAt: ago(1 * DAY), staffReplied: false, now: NOW })).toEqual({ kind: "inbox" });
    // Рассылка до разговора не мешает
    expect(whoWritesWithoutCode({ lastPassage, lastMailingSentAt: ago(5 * DAY), staffReplied: false, now: NOW })).toEqual({ kind: "reopen", passageId: "p1" });
  });

  it("завершил, срок вышел, заблокировал — во «Входящие», даже если недавно", () => {
    for (const status of ["completed", "term_ended", "blocked"] as const) {
      const lastPassage = { id: "p1", status, lastActivityAt: ago(DAY) };
      expect(whoWritesWithoutCode({ lastPassage, lastMailingSentAt: null, staffReplied: false, now: NOW })).toEqual({ kind: "inbox" });
    }
  });
});
