import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import type { ModelCatalog } from "@ykurilov/agent-chat-core";
import { wrapLanguageModel, type LanguageModel } from "ai";
import { wrapCatalogModels } from "./catalog-models";

/**
 * Конструктор иногда пишет эксперту «Записал», а правку не вызвал или она вернула ошибку: эксперт думает, что
 * настройка сохранена, а её нет. Ответ, где так сказано без удачной правки в этом ходе, эксперту не уходит: модель
 * получает пометку и отвечает заново — может сохранить правку или сказать, что не сохранилось. Ответ без таких слов
 * эксперт видит по ходу печати, по фразам.
 */

const EDIT_TOOL = "edit_lead_magnet";

/**
 * «Записал», «добавил», «поменял», «завёл»… от первого лица и «Готово» в начале фразы — о правке этого хода.
 * «Настройки сохранены», «всё записано» — о прошлых правках: черновик сохраняется сам, это правда.
 * «Не записал», «записал бы» — не о сохранении: так говорят о предложении, которое ждёт согласия.
 */
const SAVED_CLAIM =
  /(?<!\p{L})(?<!(?<!\p{L})не\s+)(?:записал|добавил|сохранил|поменял|изменил|обновил|исправил|убрал|заменил|вписал|внёс|внес|прописал|настроил|переписал|удалил|заложил|поставил|завёл|завел|создал|подключил)а?(?!\p{L})(?!\s+бы(?!\p{L}))|(?:^|[.!?…]\s+)готово(?!\p{L})/iu;

/**
 * Пометка последним сообщением запроса: начало запроса то же, кэш модели цел. В историю не пишется.
 * Текст постоянный.
 */
export const SAVE_CLAIM_NOTE =
  "Проверка приложения: в этом ответе edit_lead_magnet ничего не сохранил, а ты пишешь эксперту, что записал, сохранил или поменял. " +
  "Если эксперт просил правку и согласие на неё уже есть — вызови edit_lead_magnet сейчас и ответь по его результату. " +
  "Если ты только предлагаешь изменение и согласия ещё нет — ничего не записывай и скажи, что предлагаешь. " +
  "Если вызов вернул ошибку или вызвать нельзя — прямо скажи эксперту, что не сохранилось. " +
  "Если правки не нужно или она была в прошлых ответах — не пиши, что записал сейчас.";

/** Добавка к пометке, когда начало ответа эксперт уже видел. Текст постоянный. */
export const SHOWN_PART_NOTE = "Начало ответа выше эксперт уже видит: продолжи с того места и не повторяй его.";

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

type Part = LanguageModelV4StreamPart;

/**
 * До какого места текст можно показать: конец фразы или строки. Слова до него целые — «Записал» не разорвётся
 * между кусками, а новый ответ после пометки начнётся с новой фразы.
 */
function shownUpTo(text: string, shown: string): number {
  let cut = 0;
  for (const match of text.matchAll(/[.!?…:;]\s|\n/g)) {
    const end = match.index + match[0].length;
    if (claimsSaved(shown + text.slice(0, end))) break;
    cut = end;
  }
  return cut;
}

/** Запрос заново: показанное начало ответа — сообщением модели, пометка — последним. */
function promptAgain(prompt: Prompt, shown: string): Prompt {
  const said = shown.trimEnd();
  return [
    ...prompt,
    ...(said ? [{ role: "assistant" as const, content: [{ type: "text" as const, text: said }] }] : []),
    { role: "user", content: [{ type: "text", text: said ? `${SAVE_CLAIM_NOTE} ${SHOWN_PART_NOTE}` : SAVE_CLAIM_NOTE }] },
  ];
}

/**
 * Шаг идёт эксперту по фразам. Фраза с «записал» и всё после неё придерживаются до конца шага: вызвал модель правку
 * или шаг сорвался — придержанное уходит как есть; нет — модель отвечает заново после уже показанного начала.
 */
function holdSavedClaims(first: ReadableStream<Part>, askAgain: (shown: string) => Promise<ReadableStream<Part>>): ReadableStream<Part> {
  let reader = first.getReader();
  let cancelled = false;
  return new ReadableStream<Part>({
    start(controller) {
      const held: Part[] = [];
      const openTexts = new Set<string>();
      const openReasoning = new Set<string>();
      let shown = "";
      let passThrough = false;
      const emit = (part: Part) => {
        if (part.type === "text-start") openTexts.add(part.id);
        if (part.type === "text-end") openTexts.delete(part.id);
        if (part.type === "reasoning-start") openReasoning.add(part.id);
        if (part.type === "reasoning-end") openReasoning.delete(part.id);
        if (part.type === "text-delta") shown += part.delta;
        controller.enqueue(part);
      };
      const heldText = () => held.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("");
      // Придержанное до `length` символов текста — эксперту; конец шага остаётся до решения
      const release = (length: number) => {
        let left = length;
        while (held.length > 0 && held[0]!.type !== "finish") {
          const part = held[0]!;
          if (part.type !== "text-delta") emit(held.shift()!);
          else if (left === 0) break;
          else if (part.delta.length <= left) {
            left -= part.delta.length;
            emit(held.shift()!);
          } else {
            emit({ ...part, delta: part.delta.slice(0, left) });
            held[0] = { ...part, delta: part.delta.slice(left) };
            left = 0;
          }
        }
      };
      const flush = () => held.splice(0).forEach(emit);

      void (async () => {
        try {
          for (let next = await reader.read(); !next.done; next = await reader.read()) {
            const part = next.value;
            if (passThrough) emit(part);
            else if (part.type === "tool-call" || part.type === "tool-input-start" || part.type === "error") {
              // Шаг с вызовом или ошибкой не переделывается
              flush();
              passThrough = true;
              emit(part);
            } else if (held.length === 0 && part.type !== "text-delta" && part.type !== "finish") emit(part);
            else {
              held.push(part);
              if (part.type === "text-delta") release(shownUpTo(heldText(), shown));
            }
          }
        } catch (error) {
          if (cancelled) return;
          flush();
          controller.error(error);
          return;
        }
        // Эксперт ушёл или остановил ход: дочитывать и переспрашивать некому
        if (cancelled) return;
        if (passThrough || !claimsSaved(shown + heldText())) {
          flush();
          controller.close();
          return;
        }

        console.warn(`[записал без правки] ${(shown + heldText()).slice(0, 120)}`);
        let second: ReadableStream<Part>;
        try {
          second = await askAgain(shown);
        } catch {
          if (cancelled) return;
          flush();
          controller.close();
          return;
        }
        if (cancelled) {
          void second.cancel();
          return;
        }
        // Начатое закрывается: новый ответ — отдельным куском после показанного
        for (const id of openReasoning) controller.enqueue({ type: "reasoning-end", id });
        for (const id of openTexts) controller.enqueue({ type: "text-end", id });
        // Отброшенный ответ тоже оплачен: его расход — к расходу нового
        const spent = held.find((part) => part.type === "finish")?.usage;
        reader = second.getReader();
        try {
          for (let next = await reader.read(); !next.done; next = await reader.read()) {
            const part = next.value;
            controller.enqueue(part.type === "finish" && spent ? { ...part, usage: addUsage(spent, part.usage) } : part);
          }
          if (!cancelled) controller.close();
        } catch (error) {
          if (!cancelled) controller.error(error);
        }
      })();
    },
    cancel: (reason) => {
      cancelled = true;
      return reader.cancel(reason);
    },
  });
}

/** Модель конструктора: ответ «записал» без удачной правки в ходе переделывается один раз. */
export function guardSaveClaims(model: LanguageModel): LanguageModel {
  if (typeof model === "string") return model;
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapStream: async ({ params, model: inner }) => {
        const first = await inner.doStream(params);
        // Правка уже сохранилась — ответ идёт как есть
        if (editSavedThisTurn(params.prompt)) return first;
        return {
          ...first,
          stream: holdSavedClaims(first.stream, async (shown) => (await inner.doStream({ ...params, prompt: promptAgain(params.prompt, shown) })).stream),
        };
      },
    },
  });
}

/** Каталог конструктора: ответ «записал» без удачной правки в ходе модель переделывает один раз. */
export function withSaveClaimGuard(catalog: ModelCatalog): ModelCatalog {
  return wrapCatalogModels(catalog, guardSaveClaims);
}
