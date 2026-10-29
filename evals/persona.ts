// Персонаж eval — отдельный агент на своей модели (persona-model.ts): отвечает собеседнику и сам решает, когда закончить.
import { randomUUID } from "node:crypto";
import { createChatService, createInMemoryChatStorage, loadCurrentBranch } from "@ykurilov/agent-chat-core";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { textOf, toolCallsOf } from "./chat-parts";
import type { UsageTotals } from "./types";
import { totalUsage } from "./usage";
import type { PersonaModel } from "./persona-model";
import { CLIENT_WAIT_HOURS_TOOL, CLIENT_WAIT_TOMORROW_TOOL } from "./persona-prompts";

export interface PersonaReply {
  text: string;
  /** Персонаж вызвал инструмент выхода. */
  finished: boolean;
  /** Клиент при выходе отметил, что последней репликой попрощался или отказался. У эксперта не спрашивается. */
  saidGoodbye?: boolean;
  /** Клиент программы решил промолчать: до завтра или столько часов. */
  silence?: "tomorrow" | number;
  /** Что персонаж сделал не по роли, но собеседнику не ушло: текст после инструмента, ответ целиком не по-русски. */
  slips?: string[];
}

export interface Persona {
  reply(incoming: string): Promise<PersonaReply>;
  usage(): Promise<UsageTotals>;
}

const OWNER = "eval-persona";

const RUSSIAN_ONLY = `Язык: пиши только по-русски, каждое слово реплики. Ни одной фразы на английском.
Не рассуждай вслух о роли, сценарии или игре: в реплике только то, что твой персонаж пишет собеседнику.`;
/** Повторная просьба, если реплика вышла целиком не по-русски. */
export const RUSSIAN_ONLY_RETRY = "[Твоя реплика была не по-русски. Напиши её заново: только по-русски и только то, что персонаж пишет собеседнику.]";

/** Ссылки, почта и ники — не речь: латиница в них не значит, что модель перешла на английский. */
const NOT_SPEECH = /https?:\/\/\S+|\S+@\S+|@\w+|\b[\w-]+(?:\.[\w-]+)+\/\S*/g;

/** Предложение из трёх и больше латинских слов, где латиницы больше кириллицы, — мысли модели вслух, а не реплика. */
function isForeignSentence(sentence: string): boolean {
  const speech = sentence.replace(NOT_SPEECH, " ");
  const latin = speech.match(/[A-Za-z]/g)?.length ?? 0;
  const cyrillic = speech.match(/[А-Яа-яЁё]/g)?.length ?? 0;
  return /[A-Za-z]+(?:[^A-Za-z]+[A-Za-z]+){2,}/.test(speech) && latin > cyrillic;
}

/** Предложения не по-русски в реплике — для проверки «персонаж держал роль». */
export const foreignSentences = (text: string) =>
  text.split("\n").flatMap((line) => sentencesOf(line).filter(isForeignSentence)).map((sentence) => sentence.trim());

/** Конец предложения: знак препинания, за которым пробел или заглавная буква — модель иногда клеит мысль к реплике без пробела. */
const sentencesOf = (line: string) => line.split(/(?<=[.!?…])(?=\s|[A-ZА-ЯЁ])/);

const russianLines = (text: string) =>
  text
    .split("\n")
    .map((line) => sentencesOf(line).filter((sentence) => !isForeignSentence(sentence)).join("").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const SAID_GOODBYE = z
  .boolean()
  .describe("true — твоя последняя реплика боту была прощанием или отказом. false — ты пропадаешь посреди разговора, не прощаясь.");

export async function createPersona(input: {
  model: PersonaModel;
  instructions: string;
  exitTool: string;
  exitDescription: string;
  /** Спросить при выходе, попрощался ли персонаж (клиенты). */
  askGoodbye?: boolean;
  /** Клиент программы на несколько дней может промолчать: часы стенда пойдут вперёд. */
  silenceTools?: boolean;
}): Promise<Persona> {
  const reason = z.string().describe("Почему заканчиваешь");
  const silenceResult = "Ты молчишь. Следующее сообщение покажет, сколько прошло времени и что бот написал. Больше ничего не пиши.";
  const silenceTools: ToolSet = input.silenceTools
    ? {
        [CLIENT_WAIT_TOMORROW_TOOL]: tool({
          description: "Промолчать до завтра: не отвечать боту до следующего утра",
          inputSchema: z.object({ reason: z.string().describe("Почему молчишь") }),
          execute: async () => silenceResult,
        }),
        [CLIENT_WAIT_HOURS_TOOL]: tool({
          description: "Промолчать несколько часов: занят, отвлёкся, ушёл делать",
          inputSchema: z.object({ hours: z.number().min(1).max(12).describe("Сколько часов молчать"), reason: z.string().describe("Почему молчишь") }),
          execute: async () => silenceResult,
        }),
      }
    : {};
  const silenceNames = Object.keys(silenceTools);
  const storage = createInMemoryChatStorage();
  const choice = input.model.choice;
  const service = createChatService({
    storage,
    catalog: input.model.catalog,
    defaultChoice: choice,
    env: input.model.env,
    agent: {
      instructions: `${input.instructions}\n\n${RUSSIAN_ONLY}`,
      // Один шаг: после выхода или молчания модель не зовут ещё раз — иначе она дописывает «итог разговора»
      maxSteps: 1,
      tools: {
        [input.exitTool]: tool({
          description: input.exitDescription,
          inputSchema: input.askGoodbye ? z.object({ reason, saidGoodbye: SAID_GOODBYE }) : z.object({ reason }),
          execute: async () => "Разговор закончен. Больше ничего не пиши.",
        }),
        ...silenceTools,
      },
    },
  });
  const chatId = randomUUID();
  await storage.createChat({ id: chatId, ownerId: OWNER, ...choice });

  return {
    async reply(incoming) {
      const first = await say(incoming);
      const allForeign = !first.reply.text && first.heard !== "" && !first.reply.finished;
      if (!allForeign) return first.reply;
      const retried = (await say(RUSSIAN_ONLY_RETRY)).reply;
      const slips = [...(first.reply.slips ?? []), `ответ целиком не по-русски, переспросили: «${first.heard}»`, ...(retried.slips ?? [])];
      return { ...retried, slips };
    },
    async usage() {
      return totalUsage(await storage.sumUsage({}));
    },
  };

  /** `heard` — что модель написала на самом деле, `reply.text` — то, что из этого уходит собеседнику. */
  async function say(incoming: string): Promise<{ reply: PersonaReply; heard: string }> {
      const stream = await service.sendMessage(OWNER, chatId, { id: randomUUID(), role: "user", parts: [{ type: "text", text: incoming }] });
      const reader = stream.getReader();
      while (!(await reader.read()).done);
      const answer = (await loadCurrentBranch(storage, chatId)).at(-1);
      if (answer?.role !== "assistant" || answer.status !== "complete")
        throw new Error(`Персонаж не ответил: ${answer?.status ?? "нет ответа"}${answer?.error ? ` (${answer.error.kind})` : ""}`);
      const stopTools = [input.exitTool, ...silenceNames].map((name) => `tool-${name}`);
      const exitAt = answer.parts.findIndex((part) => stopTools.includes(part.type));
      // После выхода или молчания модель иногда дописывает «итог разговора» — собеседнику это не уходит.
      const spoken = exitAt < 0 ? answer : { parts: answer.parts.slice(0, exitAt) };
      const heard = textOf([spoken]);
      const exit = toolCallsOf([answer]).find((call) => call.name === input.exitTool);
      const saidGoodbye = (exit?.input as { saidGoodbye?: unknown } | undefined)?.saidGoodbye;
      const reply: PersonaReply = { text: russianLines(heard), finished: Boolean(exit) };
      if (exit && input.askGoodbye && typeof saidGoodbye === "boolean") reply.saidGoodbye = saidGoodbye;
      const silence = exit ? undefined : toolCallsOf([answer]).find((call) => silenceNames.includes(call.name));
      if (silence) {
        const hours = (silence.input as { hours?: unknown }).hours;
        reply.silence = silence.name === CLIENT_WAIT_TOMORROW_TOOL ? "tomorrow" : typeof hours === "number" ? hours : 3;
      }
      const afterStop = exitAt < 0 ? "" : textOf([{ parts: answer.parts.slice(exitAt + 1) }]).trim();
      if (afterStop) reply.slips = [`текст после ${answer.parts[exitAt]!.type.replace(/^tool-/, "")}: «${afterStop}»`];
      return { reply, heard };
  }
}
