// Разговор клиента с ботом: как стенд отмечает, чем кончился разговор.
import { describe, expect, it } from "vitest";
import type { ClientLine } from "./app-under-test";
import { runClientSession } from "./client-session";
import type { Persona, PersonaReply } from "./persona";
import { consultantTurn, flowStart, silent } from "./test-fixtures";
import { SILENCE_TILL_END } from "./types";

const line: ClientLine = {
  send: async (text) => consultantTurn({ client: text, bot: ["Так всё верно, подходит?"] }),
  wait: async () => consultantTurn({ client: "", silence: "до завтра", bot: [] }),
  waitTillEnd: async () => consultantTurn({ client: "", silence: SILENCE_TILL_END, bot: [] }),
  passage: async () => ({ status: "active", summary: null, personMessageCount: 1, handoverReason: null }),
  chat: async () => [],
  shortLinks: async () => [],
  flowRun: async () => undefined,
  usage: async () => undefined,
};

function personaSaying(...replies: PersonaReply[]): Persona {
  return { reply: async () => replies.shift() ?? { text: "", finished: true }, usage: async () => ({ inputTokens: 0, outputTokens: 0, costUsd: 0 }) as never };
}

const session = (client: Persona) => runClientSession({ line, client, startCode: "code", replyLimit: 14, index: 1, name: "Марина" });

describe("runClientSession", () => {
  it("клиент ушёл молча без отметки о прощании — уход посреди разговора", async () => {
    const run = await session(personaSaying({ text: "Ну давайте попробую", finished: false }, { text: "", finished: true }));
    expect(run.endedBy).toBe("client_left");
    expect(run.leftMidConversation).toBe(true);
  });

  it("клиент написал реплику и ушёл, не прощаясь, — уход посреди разговора", async () => {
    const run = await session(personaSaying({ text: "хз если честно", finished: true, saidGoodbye: false }));
    expect(run.endedBy).toBe("client_left");
    expect(run.leftMidConversation).toBe(true);
  });

  it("клиент попрощался — словами сразу или молча после прощания — это не уход посреди разговора", async () => {
    const atOnce = await session(personaSaying({ text: "Спасибо, не надо, пока", finished: true, saidGoodbye: true }));
    expect(atOnce.endedBy).toBe("client_left");
    expect(atOnce.leftMidConversation).toBeFalsy();
    const afterwards = await session(personaSaying({ text: "Не, мне не надо, пока", finished: false }, { text: "", finished: true, saidGoodbye: true }));
    expect(afterwards.leftMidConversation).toBeFalsy();
  });

  it("клиент программы молчит: стенд ждёт, следующую реплику клиент пишет, увидев, что бот прислал за это время", async () => {
    const waited: unknown[] = [];
    const heard: string[] = [];
    let status = "active";
    const programLine: ClientLine = {
      ...line,
      wait: async (silence) => {
        waited.push(silence);
        if (waited.length === 2) status = "term_ended";
        return silent("до завтра", waited.length + 1, "10:00", [["outreach", waited.length + 1, "10:00", `Утро ${waited.length + 1}`]]);
      },
      passage: async () => ({ status, summary: null, personMessageCount: 1, handoverReason: null }),
    };
    const replies: PersonaReply[] = [
      { text: "Ок, завтра гляну", finished: false, silence: "tomorrow" },
      { text: "", finished: false, silence: 3 },
    ];
    const client: Persona = { reply: async (incoming) => (heard.push(incoming), replies.shift() ?? { text: "", finished: true }), usage: async () => ({}) as never };
    const run = await runClientSession({ line: programLine, client, startCode: "code", replyLimit: 14, index: 1, name: "Игорь" });
    expect(waited).toEqual(["tomorrow", 3]);
    expect(heard[1]).toContain("[день 2, 10:00] Утро 2");
    expect(run.turns.map((turn) => turn.silence ?? turn.client)).toEqual(["/start code", "Ок, завтра гляну", "до завтра", "до завтра"]);
    expect(run.clientReplies).toBe(1);
    expect(run.endedBy).toBe("program_ended");
  });

  it("прохождение закрыто приложением: «Итог» мимо finish_dialog и предел сообщений подписаны каждый своей меткой", async () => {
    const closed = (endReason: string): ClientLine => ({
      ...line,
      passage: async () => ({ status: "completed", summary: null, personMessageCount: 4, handoverReason: null }),
      flowRun: async () => ({ transitions: [], endReason }),
    });
    const client = () => personaSaying({ text: "Да, давайте", finished: false });
    const viaFinal = await runClientSession({ line: closed("final"), client: client(), startCode: "code", replyLimit: 14, index: 1, name: "Денис" });
    expect(viaFinal.endedBy).toBe("final_without_finish");
    const byLimit = await runClientSession({ line: closed("message_limit"), client: client(), startCode: "code", replyLimit: 14, index: 1, name: "Денис" });
    expect(byLimit.endedBy).toBe("message_limit");
  });

  it("клиент молчит бесконечно — стенд останавливается, а не крутится вечно", async () => {
    const client: Persona = { reply: async () => ({ text: "", finished: false, silence: "tomorrow" }), usage: async () => ({}) as never };
    const run = await runClientSession({ line, client, startCode: "code", replyLimit: 14, index: 1, name: "Игорь", days: 3 });
    expect(run.turns.filter((turn) => turn.silence === "до завтра").length).toBeLessThanOrEqual(12);
    expect(run.turns.at(-1)!.silence).toBe(SILENCE_TILL_END);
    expect(run.endedBy).toBe("reply_limit");
  });

  it("клиент ушёл, а разговор идёт — молчит до конца разговора; путь и расход сценария — в итоге", async () => {
    let status = "active";
    const leftLine: ClientLine = {
      ...line,
      waitTillEnd: async () => {
        status = "not_completed";
        return consultantTurn({ client: "", silence: SILENCE_TILL_END, bot: ["Вы тут?"] });
      },
      passage: async () => ({ status, summary: null, personMessageCount: 1, handoverReason: null }),
      flowRun: async () => ({ transitions: [flowStart()], endReason: "abandoned" }),
      usage: async () => ({ answerUsd: 0.01, firstMessageUsd: 0.001, correctionUsd: 0, judgeUsd: 0.0001 }),
    };
    const run = await runClientSession({ line: leftLine, client: personaSaying({ text: "хз", finished: true, saidGoodbye: false }), startCode: "code", replyLimit: 14, index: 1, name: "Олег" });
    expect(run.endedBy).toBe("client_left");
    expect(run.turns.at(-1)).toMatchObject({ silence: SILENCE_TILL_END, bot: ["Вы тут?"] });
    expect(run.passage?.status).toBe("not_completed");
    expect(run.flow?.endReason).toBe("abandoned");
    expect(run.usage?.judgeUsd).toBe(0.0001);
  });

  it("консультант завершил или разговор уже кончился — молчания до конца нет", async () => {
    let tails = 0;
    const finishing: ClientLine = {
      ...line,
      send: async (text) => consultantTurn({ client: text, finished: text === "Да" }),
      waitTillEnd: async () => (tails++, consultantTurn({ silence: SILENCE_TILL_END })),
    };
    const run = await runClientSession({ line: finishing, client: personaSaying({ text: "Да", finished: false }), startCode: "code", replyLimit: 14, index: 1, name: "Марина" });
    expect(run.endedBy).toBe("consultant_finished");
    const ended: ClientLine = { ...line, waitTillEnd: finishing.waitTillEnd, passage: async () => ({ status: "completed", summary: null, personMessageCount: 1, handoverReason: null }) };
    await runClientSession({ line: ended, client: personaSaying(), startCode: "code", replyLimit: 14, index: 1, name: "Марина" });
    expect(tails).toBe(0);
  });
});
