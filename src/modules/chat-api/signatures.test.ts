import { describe, expect, it } from "vitest";
import { createChatSignatures, VOICE_TICKET_TTL_MS } from "./signatures";

const VISITOR = "3f1e2d4c-5b6a-4789-9abc-def012345678";
const MESSAGE = "a1b2c3d4-e5f6-4789-8abc-0123456789ab";

function signaturesAt(time: { now: number }, key = "test-key") {
  return createChatSignatures(key, { now: () => new Date(time.now) });
}

describe("билет голоса из браузера", () => {
  it("узнаёт своего посетителя, пока билет не истёк", () => {
    const time = { now: Date.UTC(2026, 10, 1) };
    const signatures = signaturesAt(time);
    const ticket = signatures.voiceTicket(VISITOR);
    expect(signatures.visitorOfVoiceTicket(ticket)).toBe(VISITOR);
    time.now += VOICE_TICKET_TTL_MS - 1000;
    expect(signatures.visitorOfVoiceTicket(ticket)).toBe(VISITOR);
    time.now += 2000;
    expect(signatures.visitorOfVoiceTicket(ticket)).toBeNull();
  });

  it("подделанный, чужим ключом или пустой — никого", () => {
    const time = { now: Date.UTC(2026, 10, 1) };
    const ticket = signaturesAt(time).voiceTicket(VISITOR);
    const other = "00000000-0000-4000-8000-000000000000";
    expect(signaturesAt(time).visitorOfVoiceTicket(ticket.replace(VISITOR, other))).toBeNull();
    expect(signaturesAt(time, "other-key").visitorOfVoiceTicket(ticket)).toBeNull();
    expect(signaturesAt(time).visitorOfVoiceTicket("")).toBeNull();
    expect(signaturesAt(time).visitorOfVoiceTicket(null)).toBeNull();
    expect(signaturesAt(time).visitorOfVoiceTicket("a.b.c.d")).toBeNull();
  });
});

describe("ссылка на картинку для виджета", () => {
  it("адрес от приложения; по нему узнаётся посетитель, кому ушла картинка", () => {
    const signatures = signaturesAt({ now: 0 });
    const url = new URL(signatures.imageUrl("https://livem.example", VISITOR, MESSAGE));
    expect(url.origin).toBe("https://livem.example");
    expect(url.pathname).toBe(`/api/v1/images/${MESSAGE}`);
    expect(signatures.visitorOfImage(MESSAGE, url.searchParams)).toBe(VISITOR);
  });

  it("подпись другой картинки или другого посетителя не подходит", () => {
    const signatures = signaturesAt({ now: 0 });
    const url = new URL(signatures.imageUrl("https://livem.example", VISITOR, MESSAGE));
    expect(signatures.visitorOfImage("b1b2c3d4-e5f6-4789-8abc-0123456789ab", url.searchParams)).toBeNull();
    url.searchParams.set("v", "00000000-0000-4000-8000-000000000000");
    expect(signatures.visitorOfImage(MESSAGE, url.searchParams)).toBeNull();
    expect(signatures.visitorOfImage(MESSAGE, new URLSearchParams())).toBeNull();
  });
});
