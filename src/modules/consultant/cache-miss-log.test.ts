import { describe, expect, it } from "vitest";
import { cacheMissLog } from "./cache-miss-log";

const LINE = "[промах кэша] чат=chat-1 модель=deepseek/deepseek-4.1-flash провайдер=openrouter токенов=5200 ~$0.0010 пауза=3.0мин";

function setup(run: { state: string; day?: { day: number } } | null) {
  const lines: string[] = [];
  const log = cacheMissLog({
    ownerOf: async (chatId) => (chatId === "chat-1" ? "person-1" : null),
    readRun: async (ownerId, chatId) => (ownerId === "person-1" && chatId === "chat-1" ? run : null),
    log: (line) => lines.push(line),
  });
  return { log, lines };
}

describe("строка «[промах кэша]» с днём и нодой", () => {
  it("к строке SDK — день программы и нода чата: промахи раскладываются по дням и нодам", async () => {
    const { log, lines } = setup({ state: "polish", day: { day: 2 } });
    await log(LINE);
    expect(lines).toEqual([`${LINE} день=2 нода=polish`]);
  });

  it("лидмагнит без программы — только нода; чат не по сценарию — строка как есть", async () => {
    const plain = setup({ state: "conversation" });
    await plain.log(LINE);
    expect(plain.lines).toEqual([`${LINE} нода=conversation`]);
    const none = setup(null);
    await none.log(LINE);
    expect(none.lines).toEqual([LINE]);
  });

  it("другие строки журнала и сбой чтения сценария — строка уходит как есть", async () => {
    const { log, lines } = setup({ state: "polish", day: { day: 2 } });
    await log("[сценарий] чат=chat-1 что-то ещё");
    expect(lines).toEqual(["[сценарий] чат=chat-1 что-то ещё"]);

    const broken: string[] = [];
    await cacheMissLog({ ownerOf: async () => "person-1", readRun: async () => Promise.reject(new Error("нет базы")), log: (line) => broken.push(line) })(LINE);
    expect(broken).toEqual([LINE]);
  });
});
