import { inArray } from "drizzle-orm";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { listCorrections, resolveCorrections, type AnswerCorrection, type AnswerKind, type CorrectionContextLine, type CorrectionOutcome } from "../corrections";
import { getLeadMagnet } from "../lead-magnets";
import { leadMagnetVersions } from "../lead-magnets/schema";
import type { Database } from "../platform/db";
import { AGENT_TIME_ZONE } from "../platform/models-catalog";
import { conversationOfChat } from "../role-swap";
import type { ToolResult } from "./tools";

export const ANSWER_CORRECTION_TOOL_NAMES = ["read_answer_corrections", "resolve_answer_corrections"] as const;

const STATUSES = ["pending", "resolved", "all"] as const;
type StatusFilter = (typeof STATUSES)[number];

const KIND: Record<AnswerKind, string> = { reply: "ответ", first_message: "первое сообщение", farewell: "ответ с прощанием" };
const NONE: Record<StatusFilter, string> = { pending: "Неразобранных правок нет.", resolved: "Разобранных правок нет.", all: "Правок нет." };

const time = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: AGENT_TIME_ZONE });

const SPEAKERS = { preview: { user: "Человек", assistant: "Консультант" }, role_swap: { user: "Клиент", assistant: "Эксперт за консультанта" } } as const;

/** Кусок разговора перед ответом: реплики по порядку, отметка ноды — когда она меняется. */
function contextLines(context: readonly CorrectionContextLine[], speakers: { user: string; assistant: string } = SPEAKERS.preview): string[] {
  const out: string[] = [];
  let lastStage: string | undefined;
  for (const line of context) {
    if (line.stage && line.stage !== lastStage) out.push(`[этап: ${line.stage}]`);
    lastStage = line.stage ?? lastStage;
    out.push(`${speakers[line.role]}: ${line.text}`);
  }
  return out;
}

function outcomeText(correction: AnswerCorrection, versionTimes: ReadonlyMap<string, Date>): string {
  switch (correction.outcome) {
    case "applied": {
      const at = correction.resolvedVersionId ? versionTimes.get(correction.resolvedVersionId) : undefined;
      return at ? `учтено в версии от ${time.format(at)}` : "учтено";
    }
    case "rejected":
      return "отклонено";
    case "already_covered":
      return "уже учтено";
    default:
      return "";
  }
}

/** Правки лидмагнита текстом для конструктора: по блоку на правку (contracts/constructor.md). */
export async function readAnswerCorrections(db: Database, leadMagnetId: string, input: { status?: StatusFilter }): Promise<string> {
  const status = input.status ?? "pending";
  const lead = await getLeadMagnet(db, leadMagnetId);
  if (!lead) throw new Error(`Лидмагнит ${leadMagnetId} не найден`);
  const corrections = await listCorrections(db, leadMagnetId, { status });
  if (corrections.length === 0) return NONE[status];

  const stageTitle = new Map(lead.draft.flow.states.map((state) => [state.id, state.title]));
  const versionIds = [...new Set(corrections.flatMap((one) => (one.resolvedVersionId ? [one.resolvedVersionId] : [])))];
  const versions =
    versionIds.length === 0
      ? []
      : await db.select({ id: leadMagnetVersions.id, createdAt: leadMagnetVersions.createdAt }).from(leadMagnetVersions).where(inArray(leadMagnetVersions.id, versionIds));
  const versionTimes = new Map(versions.map((version) => [version.id, version.createdAt]));

  const outcome = (correction: AnswerCorrection) => (correction.status === "resolved" ? [`Итог: ${outcomeText(correction, versionTimes)}`] : []);
  const oldDraft = (correction: AnswerCorrection) => (correction.draftVersionId === lead.draftVersionId ? "нет" : "да");

  const previewBlock = (correction: AnswerCorrection) => {
    const header = [
      `Правка ${correction.id}`,
      time.format(correction.createdAt),
      ...(correction.stageId ? [`нода «${stageTitle.get(correction.stageId) ?? correction.stageId}»`] : []),
      ...(correction.programDay !== null ? [`день ${correction.programDay}`] : []),
      KIND[correction.answerKind],
    ].join(" · ");
    return [
      header,
      `Сделана на старой версии черновика: ${oldDraft(correction)}`,
      `Действия в ответе: ${correction.actions.length > 0 ? correction.actions.join(", ") : "нет"}`,
      "Перед ответом:",
      ...contextLines(correction.context),
      `Было: ${correction.originalText}`,
      `Стало: ${correction.correctedText}`,
      `Почему: ${correction.reason ?? "не написано"}`,
      ...outcome(correction),
    ].join("\n");
  };

  // «Поменяемся ролями»: ответ эксперта за консультанта рядом с тем, что ответил бы консультант, и правка реплики клиента
  const roleSwapBlock = (correction: AnswerCorrection) =>
    correction.agentRole === "client"
      ? [
          `Правка реплики клиента ${correction.id}`,
          "Перед репликой:",
          ...contextLines(correction.context, SPEAKERS.role_swap),
          `Агент-клиент написал: ${correction.originalText}`,
          `Эксперт исправил на: ${correction.correctedText}`,
          `Почему: ${correction.reason ?? "не написано"}`,
          ...outcome(correction),
        ].join("\n")
      : [
          `Ответ эксперта ${correction.id} · ${correction.stageId ? `нода «${stageTitle.get(correction.stageId) ?? correction.stageId}»` : "без ноды"}`,
          `Сделан на старой версии черновика: ${oldDraft(correction)}`,
          "Перед ответом:",
          ...contextLines(correction.context, SPEAKERS.role_swap),
          `Консультант ответил бы: ${correction.originalText || "не удалось посчитать"}`,
          `Эксперт ответил: ${correction.correctedText}`,
          ...outcome(correction),
        ].join("\n");

  // Записи одного разговора «Поменяемся ролями» — группой на месте первой из них
  const groups = new Map<string, AnswerCorrection[]>();
  const order: Array<AnswerCorrection | string> = [];
  for (const correction of corrections) {
    if (correction.source !== "role_swap") {
      order.push(correction);
      continue;
    }
    const group = groups.get(correction.chatId);
    if (group) group.push(correction);
    else {
      groups.set(correction.chatId, [correction]);
      order.push(correction.chatId);
    }
  }
  const conversations = new Map(
    await Promise.all([...groups.keys()].map(async (chatId) => [chatId, await conversationOfChat(db, chatId)] as const)),
  );

  return order
    .map((item) => {
      if (typeof item !== "string") return previewBlock(item);
      const group = groups.get(item)!;
      const conversation = conversations.get(item);
      const header = [
        `Разговор «Поменяемся ролями» ${item} · ${time.format(conversation?.createdAt ?? group[0]!.createdAt)}`,
        ...(conversation ? [`Клиента играл агент: ${conversation.clientCard}`] : []),
      ].join("\n");
      return [header, ...group.map(roleSwapBlock)].join("\n\n");
    })
    .join("\n\n");
}

/** Итог разбора правок, всё или ничего. */
export async function resolveAnswerCorrections(
  db: Database,
  leadMagnetId: string,
  input: { ids: string[]; outcome: CorrectionOutcome },
): Promise<ToolResult<{ resolved: number }>> {
  const result = await resolveCorrections(db, leadMagnetId, input.ids, input.outcome);
  if (result.ok) return result;
  const ids = result.ids.join(", ");
  return {
    ok: false,
    error:
      result.error === "not_pending"
        ? `Среди неразобранных правок этого лидмагнита нет: ${ids}. Ничего не отмечено.`
        : `Черновик не менялся после правок: ${ids}. Сначала запишите изменение через edit_lead_magnet после согласия эксперта. Ничего не отмечено.`,
  };
}

/** Инструменты разбора правок ответов консультанта. `onChange` — правки разобраны: счёт неразобранных на экране устарел. */
export function createAnswerCorrectionTools(db: Database, leadMagnetId: () => Promise<string>, onChange: () => void): ToolSet {
  return {
    read_answer_corrections: tool({
      title: "Чтение правок ответов",
      description:
        "Прочитать правки, которыми эксперт исправил ответы консультанта в «Проверке», и записи разговоров «Поменяемся ролями»: " +
          "ответы эксперта за консультанта и правки реплик агента-клиента. Рядом — разговор перед ответом. " +
        "По умолчанию — неразобранные.",
      inputSchema: z.strictObject({ status: z.enum(STATUSES).optional() }),
      execute: async (input) => readAnswerCorrections(db, await leadMagnetId(), input),
    }),
    resolve_answer_corrections: tool({
      title: "Разбор правок ответов",
      description:
        "Отметить правки разобранными с итогом решения эксперта: applied — изменение записано, rejected — эксперт отказался, " +
        "already_covered — настройки уже это учитывают.",
      inputSchema: z.strictObject({ ids: z.array(z.string()).min(1), outcome: z.enum(["applied", "rejected", "already_covered"]) }),
      execute: async (input) => {
        const result = await resolveAnswerCorrections(db, await leadMagnetId(), input);
        if (result.ok) onChange();
        return result;
      },
    }),
  };
}
