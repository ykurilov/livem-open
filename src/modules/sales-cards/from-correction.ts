// «Сохранить как заготовку» у исправленного ответа: текст — вариант эксперта, этап — где прозвучал ответ, название и
// «когда уместна» подсказывает модель по этому месту разговора. Эксперт правит их в окне заготовки перед сохранением.
import { generateText } from "ai";
import type { DirectModel } from "../platform/direct-model";
import type { LeadMagnetSettings } from "../lead-magnets/settings";
import { SALES_CARD_TITLE_MAX_LENGTH, SALES_CARD_WHEN_MAX_LENGTH, type SalesCardInput } from "./sales-cards";

/** Что нужно от правки ответа: место в разговоре и текст эксперта. */
export interface CorrectionForCard {
  stageId: string | null;
  correctedText: string;
  reason: string | null;
  context: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
}

const INSTRUCTIONS = `Эксперт исправил ответ своего помощника-консультанта и сохраняет свой вариант как заготовку: помощник возьмёт её, когда разговор снова придёт к такой ситуации.
Дай заготовке название — несколько слов, по которым эксперт узнает её в списке.
Напиши «когда уместна» — одну фразу о ситуации человека в разговоре: что он сказал, спросил или в каком он сомнении. Описывай ситуацию, а не тему ответа: по этой фразе помощник поймёт, что пора, и не будет сам подводить к ней разговор.
Опирайся только на переписку и ответ эксперта.
Ответь только JSON-объектом с полями title и when.`;

const clip = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max).trim();

/** Название и повод из ответа модели; не по форме — `null`. */
export function parseCardSuggestion(text: string): { title: string; when: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as { title?: unknown; when?: unknown };
    if (typeof value.title !== "string" || typeof value.when !== "string") return null;
    const title = clip(value.title, SALES_CARD_TITLE_MAX_LENGTH);
    const when = clip(value.when, SALES_CARD_WHEN_MAX_LENGTH);
    return title && when ? { title, when } : null;
  } catch {
    return null;
  }
}

function conversationText(correction: CorrectionForCard): string {
  const lines = correction.context.map((line) => `${line.role === "user" ? "Человек" : "Помощник"}: ${line.text}`);
  return [
    "Переписка до ответа:",
    ...lines,
    "",
    "Ответ эксперта:",
    correction.correctedText,
    ...(correction.reason?.trim() ? ["", `Почему эксперт так ответил: ${correction.reason.trim()}`] : []),
  ].join("\n");
}

/** Заготовка для окна: не вышло подсказать — название и повод пустые, эксперт впишет их сам. */
export async function cardFromCorrection(input: { direct: DirectModel; settings: LeadMagnetSettings; correction: CorrectionForCard }): Promise<SalesCardInput> {
  const { direct, settings, correction } = input;
  const result = await generateText({
    model: direct.model,
    system: INSTRUCTIONS,
    prompt: conversationText(correction),
    providerOptions: direct.providerOptions,
    ...(direct.headers && { headers: direct.headers }),
    abortSignal: AbortSignal.timeout(60_000),
  });
  const suggestion = parseCardSuggestion(result.text) ?? { title: "", when: "" };
  const stageExists = correction.stageId !== null && settings.flow.states.some((state) => state.id === correction.stageId);
  return { stateId: stageExists ? correction.stageId : null, ...suggestion, text: correction.correctedText, verbatim: false };
}
