import { z } from "zod";

/** Инструмент, которым консультант достаёт полный текст заготовки. */
export const SALES_CARD_TOOL = "sales_card";
/** Блок контекста хода со списком заготовок текущего этапа (рядом с карточкой этапа сценария `flow:state`). */
export const SALES_CARDS_BLOCK_KEY = "sales-cards:state";

export const SALES_CARD_TITLE_MAX_LENGTH = 80;
export const SALES_CARD_WHEN_MAX_LENGTH = 300;
export const SALES_CARD_TEXT_MAX_LENGTH = 2000;
export const SALES_CARDS_MAX_COUNT = 60;

/**
 * Заготовка эксперта: готовый текст, который консультант берёт по своему решению. `stateId` — этап доски; `null` —
 * общая шпаргалка возражений, доступна на любом этапе. `verbatim` — текст уходит человеку как есть (цена, условия,
 * ссылка), иначе консультант пересказывает его своими словами.
 */
export const salesCardSchema = z.object({
  id: z.string().min(1),
  stateId: z.string().min(1).nullable(),
  title: z
    .string()
    .trim()
    .min(1, "У заготовки должно быть название")
    .max(SALES_CARD_TITLE_MAX_LENGTH, `Название заготовки — не длиннее ${SALES_CARD_TITLE_MAX_LENGTH} знаков`),
  when: z
    .string()
    .trim()
    .min(1, "У заготовки нужно «когда уместна»")
    .max(SALES_CARD_WHEN_MAX_LENGTH, `«Когда уместна» — не длиннее ${SALES_CARD_WHEN_MAX_LENGTH} знаков`),
  text: z
    .string()
    .trim()
    .min(1, "У заготовки должен быть текст")
    .max(SALES_CARD_TEXT_MAX_LENGTH, `Текст заготовки — не длиннее ${SALES_CARD_TEXT_MAX_LENGTH} знаков`),
  verbatim: z.boolean(),
});

export const salesCardsSchema = z.array(salesCardSchema).max(SALES_CARDS_MAX_COUNT, `Заготовок — не больше ${SALES_CARDS_MAX_COUNT}`);

export type SalesCard = z.infer<typeof salesCardSchema>;

/** Короткий id новой заготовки: его видит модель в списке, длинный id — лишние знаки на каждом ходе. */
export function newSalesCardId(taken: Iterable<string> = []): string {
  const used = new Set(taken);
  for (;;) {
    const id = globalThis.crypto.randomUUID().slice(0, 8);
    if (!used.has(id)) return id;
  }
}

/**
 * Заготовки после проверки: id не повторяются (иначе — текст ошибки), заготовки удалённого этапа переходят в общую
 * шпаргалку — текст эксперта не теряется молча, он виден на доске и его можно убрать.
 */
export function checkedSalesCards(cards: readonly SalesCard[], stateIds: ReadonlySet<string>): SalesCard[] | { error: string } {
  const ids = cards.map((card) => card.id);
  if (new Set(ids).size !== ids.length) return { error: "У заготовок повторяются id" };
  return cards.map((card) => (card.stateId !== null && !stateIds.has(card.stateId) ? { ...card, stateId: null } : card));
}

/** Заготовка из формы или от конструктора: без id — новая. */
export type SalesCardInput = Omit<SalesCard, "id"> & { id?: string };

/** Добавить новую заготовку в конец или заменить прежнюю с тем же id. Этап — только из нод сценария. */
export function withSalesCard(
  cards: readonly SalesCard[],
  stateIds: ReadonlySet<string>,
  input: SalesCardInput,
): { ok: true; card: SalesCard; cards: SalesCard[] } | { ok: false; error: string } {
  if (input.stateId !== null && !stateIds.has(input.stateId))
    return { ok: false, error: `Нет этапа (ноды) с id «${input.stateId}»: укажите этап сценария или общую шпаргалку` };
  if (input.id !== undefined && !cards.some((card) => card.id === input.id)) return { ok: false, error: `Нет заготовки с id «${input.id}»` };
  const card: SalesCard = { ...input, id: input.id ?? newSalesCardId(cards.map((one) => one.id)) };
  return { ok: true, card, cards: input.id === undefined ? [...cards, card] : cards.map((one) => (one.id === card.id ? card : one)) };
}

export function withoutSalesCard(cards: readonly SalesCard[], id: string): { ok: true; cards: SalesCard[] } | { ok: false; error: string } {
  if (!cards.some((card) => card.id === id)) return { ok: false, error: `Нет заготовки с id «${id}»` };
  return { ok: true, cards: cards.filter((card) => card.id !== id) };
}

const listLine = (card: SalesCard) => `- [${card.id}] ${card.title} — ${card.when}`;

/**
 * Правило и общая шпаргалка — в неизменной инструкции версии: одна на все ходы, начало запроса из кэша.
 * Без заготовок — пусто, инструкция прежняя.
 */
export function commonCardsSection(cards: readonly SalesCard[]): string {
  if (cards.length === 0) return "";
  const rule =
    "Заготовки эксперта — его готовые тексты на частые вопросы и возражения. Перед тобой только их названия и повод; что в заготовке, знаешь только из её текста, поэтому название и повод человеку как факт не называй. " +
    "Сверяй повод с ситуацией человека по смыслу, а не по похожим словам. " +
    `Бери заготовку, когда разговор сам пришёл к её поводу и она отвечает человеку лучше твоих слов: тогда получи текст через ${SALES_CARD_TOOL} по id. ` +
    "Если в случае человека есть то, чего повод не охватывает и при чём совет заготовки был бы неверным или вредным, не бери её; а если это видно только из полученного текста — не передавай его и ответь сам. " +
    "Прежде чем сказать, что что-то уточнит эксперт, проверь список: вопрос человека может быть поводом заготовки. " +
    "Повода нет — не подводи к нему разговор и не бери заготовку ради неё самой. " +
    "Каждая заготовка — не больше одного раза за разговор. Список заготовок этапа приходит вместе с карточкой этапа.";
  const common = cards.filter((card) => card.stateId === null);
  return common.length === 0 ? rule : `${rule}\n\nЗаготовки на любом этапе:\n${common.map(listLine).join("\n")}`;
}

/**
 * Список заготовок текущего этапа блоком контекста хода: ядро шлёт блок, только когда он изменился (этап сменился),
 * и не трогает начало запроса. Нет заготовок у этапа — блока нет.
 */
export function stageCardsBlock(settings: { salesCards?: readonly SalesCard[]; flow: { states: ReadonlyArray<{ id: string; title: string }> } }, stateId: string | null): { key: string; text: string } | null {
  if (stateId === null) return null;
  const cards = (settings.salesCards ?? []).filter((card) => card.stateId === stateId);
  if (cards.length === 0) return null;
  const title = settings.flow.states.find((state) => state.id === stateId)?.title ?? stateId;
  return { key: SALES_CARDS_BLOCK_KEY, text: `Заготовки этапа «${title}»:\n${cards.map(listLine).join("\n")}` };
}
