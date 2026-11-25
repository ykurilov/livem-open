import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { DatabaseExecutor } from "../platform/db";
import { readPreviewConversation } from "./preview-store";

export const HAND_TO_EXPERT_TOOL = "hand_to_expert";

/** Пометка передачи агентом в причине «Входящих»: по ней «Входящие» отличают её от сбоя консультанта. */
export const AGENT_HANDOVER_PREFIX = "Агент передал вопрос: ";

type Chat = { ownerId: string; chatId: string };

/**
 * Что инструменту передачи нужно от приложения. Живой разговор — «Входящие» и уведомление эксперту; «Проверка» — только
 * ответ, что в живом разговоре вопрос ушёл бы эксперту. Передать можно только в разговоре после его конца.
 */
export interface ExpertHandoverPort {
  handOver(chat: Chat, summary: string): Promise<{ ok: true; test?: boolean } | { ok: false; reason: "not_after_end" }>;
}

/**
 * Передача вопроса вернувшегося человека эксперту. Инструмент есть у каждой версии с «Агент продолжит разговор» на всех
 * ходах — набор инструментов не меняется (кэш); до конца разговора он отказывает.
 */
export function createExpertHandoverTool(port: ExpertHandoverPort, chat: Chat): ToolSet {
  return {
    [HAND_TO_EXPERT_TOOL]: tool({
      description:
        "Передать вопрос человека эксперту: во «Входящие» с пометкой и уведомлением эксперту. Только в разговоре после его конца, " +
        "когда человек просит связи с экспертом или хочет того, что ты сам решить не можешь, и согласился, чтобы его вопрос передали. " +
        "Без согласия не вызывай. Эксперт ответит сам, когда сможет: сроков его ответа не обещай.",
      inputSchema: z.strictObject({
        summary: z.string().min(1).max(600).describe("Выжимка для эксперта: с чем человек пришёл и что ему нужно от эксперта, его словами"),
      }),
      execute: async ({ summary }) => {
        const result = await port.handOver(chat, summary.trim());
        if (!result.ok) return { ok: false as const, error: "Передать вопрос эксперту можно только после конца разговора. Продолжай разговор сам." };
        return {
          ok: true as const,
          next: result.test
            ? "Это проверка: в живом разговоре вопрос ушёл бы эксперту во «Входящие». Скажи человеку, что передал вопрос эксперту."
            : "Вопрос передан эксперту. Скажи человеку, что передал, и продолжай разговор, если ему нужно ещё что-то.",
        };
      },
    }),
  };
}

/** «Проверка»: тестовый разговор после конца отвечает, что вопрос ушёл бы эксперту; ни «Входящих», ни уведомлений. */
export function previewExpertHandover(db: DatabaseExecutor): ExpertHandoverPort {
  return {
    async handOver({ chatId }) {
      const preview = await readPreviewConversation(db, chatId);
      return preview?.finishedAt ? { ok: true, test: true } : { ok: false, reason: "not_after_end" };
    },
  };
}
