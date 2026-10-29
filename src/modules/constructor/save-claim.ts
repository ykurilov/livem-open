import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import type { ModelCatalog } from "@ykurilov/agent-chat-core";
import { wrapLanguageModel, type LanguageModel } from "ai";
import { wrapCatalogModels } from "./catalog-models";

/**
 * Конструктор иногда пишет эксперту «Записал», а правку не вызвал или она вернула ошибку: эксперт думает, что
 * настройка сохранена, а её нет. Ответ, где так сказано без удачной правки в этом ходе, эксперту не уходит: модель
 * получает пометку и отвечает заново — может сохранить правку или сказать, что не сохранилось.
 */

const EDIT_TOOL = "edit_lead_magnet";

/**
 * «Записал», «добавил», «поменял», «завёл»… от первого лица и «Готово» в начале фразы — о правке этого хода.
 * «Настройки сохранены», «всё записано» — о прошлых правках: черновик сохраняется сам, это правда.
 */
const SAVED_CLAIM =
  /(?<!\p{L})(?:записал|добавил|сохранил|поменял|изменил|обновил|исправил|убрал|заменил|вписал|внёс|внес|прописал|настроил|переписал|удалил|заложил|поставил|завёл|завел|создал|подключил)а?(?!\p{L})|(?:^|[.!?…]\s+)готово(?!\p{L})/iu;

/**
 * Пометка последним сообщением запроса: начало запроса то же, кэш модели цел. В историю не пишется.
 * Текст постоянный.
 */
export const SAVE_CLAIM_NOTE =
  "Проверка приложения: в этом ответе edit_lead_magnet ничего не сохранил, а ты пишешь эксперту, что записал, сохранил или поменял. " +
  "Если эксперт просил правку — вызови edit_lead_magnet сейчас и ответь по его результату. " +
  "Если вызов вернул ошибку или вызвать нельзя — прямо скажи эксперту, что не сохранилось. " +
  "Если правки не нужно или она была в прошлых ответах — не пиши, что записал сейчас.";

/** Ответ говорит эксперту, что настройка сохранена. */
export function claimsSaved(text: string): boolean {
  return SAVED_CLAIM.test(text);
}

/** Результат правки — удачный: `{ ok: true }`. Ошибка вызова и `{ ok: false }` — нет. */
export function isSavedEdit(output: unknown): boolean {
  return typeof output === "object" && output !== null && (output as { ok?: unknown }).ok === true;
}

type Prompt = LanguageModelV4CallOptions["prompt"];

/** Удачная правка в текущем ходе: после последнего ответа без вызовов (конец прошлого хода). */
function editSavedThisTurn(prompt: Prompt): boolean {
  const turnStart = prompt.findLastIndex((message) => message.role === "assistant" && !message.content.some((part) => part.type === "tool-call")) + 1;
  return prompt.slice(turnStart).some(
    (message) =>
      message.role === "tool" &&
      message.content.some((part) => part.type === "tool-result" && part.toolName === EDIT_TOOL && part.output.type === "json" && isSavedEdit(part.output.value)),
  );
}

const sum = (a: number | undefined, b: number | undefined) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));

function addUsage(a: LanguageModelV4Usage, b: LanguageModelV4Usage): LanguageModelV4Usage {
  return {
    ...b,
    inputTokens: {
      total: sum(a.inputTokens.total, b.inputTokens.total),
      noCache: sum(a.inputTokens.noCache, b.inputTokens.noCache),
      cacheRead: sum(a.inputTokens.cacheRead, b.inputTokens.cacheRead),
      cacheWrite: sum(a.inputTokens.cacheWrite, b.inputTokens.cacheWrite),
    },
    outputTokens: {
      total: sum(a.outputTokens.total, b.outputTokens.total),
      text: sum(a.outputTokens.text, b.outputTokens.text),
      reasoning: sum(a.outputTokens.reasoning, b.outputTokens.reasoning),
    },
  };
}

function streamOf(parts: LanguageModelV4StreamPart[], error?: unknown): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      if (error === undefined) controller.close();
      else controller.error(error);
    },
  });
}

async function readAll(stream: ReadableStream<LanguageModelV4StreamPart>): Promise<{ parts: LanguageModelV4StreamPart[]; error?: unknown }> {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) parts.push(next.value);
    return { parts };
  } catch (error) {
    return { parts, error };
  }
}

function guardModel(model: LanguageModel): LanguageModel {
  if (typeof model === "string") return model;
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapStream: async ({ params, model: inner }) => {
        const first = await inner.doStream(params);
        // Правка уже сохранилась — ответ идёт как есть, по кускам
        if (editSavedThisTurn(params.prompt)) return first;

        // Иначе шаг придерживается целиком: «Записал» видно только в готовом тексте
        const { parts, error } = await readAll(first.stream);
        const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("");
        const calls = parts.some((part) => part.type === "tool-call");
        if (error !== undefined || calls || parts.some((part) => part.type === "error") || !claimsSaved(text))
          return { ...first, stream: streamOf(parts, error) };

        console.warn(`[записал без правки] ${text.slice(0, 120)}`);
        let second: Awaited<ReturnType<typeof inner.doStream>>;
        try {
          second = await inner.doStream({ ...params, prompt: [...params.prompt, { role: "user", content: [{ type: "text", text: SAVE_CLAIM_NOTE }] }] });
        } catch {
          return { ...first, stream: streamOf(parts) };
        }
        // Отброшенный ответ тоже оплачен: его расход — к расходу нового
        const spent = parts.find((part) => part.type === "finish")?.usage;
        if (!spent) return second;
        return {
          ...second,
          stream: second.stream.pipeThrough(
            new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
              transform(part, controller) {
                controller.enqueue(part.type === "finish" ? { ...part, usage: addUsage(spent, part.usage) } : part);
              },
            }),
          ),
        };
      },
    },
  });
}

/** Каталог конструктора: ответ «записал» без удачной правки в ходе модель переделывает один раз. */
export function withSaveClaimGuard(catalog: ModelCatalog): ModelCatalog {
  return wrapCatalogModels(catalog, guardModel);
}
