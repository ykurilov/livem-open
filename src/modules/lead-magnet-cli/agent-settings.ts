import { randomUUID } from "node:crypto";
import { compactFlow, parseFlow, type AgentFlow, type ClientCardField } from "@ykurilov/agent-chat-flows/format";
import { z } from "zod";
import { cardFromDictionary, completeFlowJson, leadMagnetToFlow, withLeadMagnetFlow } from "../flows";
import { newProgramSettings, type LeadMagnetSettings, type ProgramSettings } from "../lead-magnets";
import { createField, FIELD_TYPES, listFields, type FieldDefinition } from "../people";
import type { DatabaseExecutor } from "../platform/db";
import { getVideos, listVideos } from "../videos";
import { productLinkSchema, type ProductLink } from "../purchases/product-links";
import { textLinkSchema, type TextLink } from "../text-links/text-link";

/** Ошибка, которую агент видит как есть: что не так и как исправить. */
export class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliInputError";
  }
}

/** Поле карточки так, как его видит агент: по названию, без служебного id. */
export interface AgentCardField {
  name: string;
  type: ClientCardField["type"];
  options?: string[];
  about: string;
  refreshAfterMonths?: number;
}

/**
 * Настройки лидмагнита для агента: сценарий (`flow`) без значений по умолчанию, поля в нём и ролики — по названиям.
 * Основная инструкция — `flow.common`. Этапы, программа, поля и просмотр ссылок старого вида не показываются.
 */
export type AgentSettings = Pick<
  LeadMagnetSettings,
  "name" | "cardDescription" | "firstMessage" | "providerId" | "modelId" | "reasoning" | "endCondition" | "farewellMessage" | "maxPersonMessages"
> & {
  flow: Record<string, unknown>;
  videos: string[];
  /** Ссылки продуктов, оплату которых узнаёт Василий; нет — пусто. */
  productLinks: ProductLink[];
  /** Ссылка с подставленным текстом; нет — null. */
  textLink: TextLink | null;
};

const stageInput = z.strictObject({
  id: z.string().optional(),
  name: z.string(),
  instruction: z.string(),
  transitionCondition: z.string(),
  startDay: z.number().int().nullable().optional(),
  isSale: z.boolean().optional(),
});

const outreachInput = z.strictObject({
  morningAt: z.string(),
  afterSilenceHours: z.array(z.number()),
  firstDayAfterSilenceMinutes: z.array(z.number()),
  maxPerDay: z.number().int(),
  latestAt: z.string(),
});

const sideTaskInput = z.strictObject({
  id: z.string().optional(),
  task: z.string(),
  field: z.string().nullable().optional(),
  when: z.string().optional(),
});

/** Всё, кроме срока, можно не указывать: берётся прежнее значение программы или умолчание. */
const programInput = z.strictObject({
  days: z.number().int().optional(),
  softDailyMessages: z.number().int().optional(),
  hardDailyMessages: z.number().int().optional(),
  outreach: outreachInput.partial().optional(),
  sideTasks: z.array(sideTaskInput).optional(),
});

const fieldInput = z.union([
  z.string(),
  z.strictObject({
    name: z.string(),
    type: z.enum(FIELD_TYPES).optional(),
    options: z.array(z.string()).optional(),
    description: z.string().optional(),
  }),
]);

const inputShape = {
  name: z.string(),
  cardDescription: z.string(),
  /** Основная инструкция — то же, что `flow.common`. */
  instruction: z.string(),
  firstMessage: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  reasoning: z.string().nullable(),
  endCondition: z.string(),
  farewellMessage: z.string(),
  maxPersonMessages: z.number().int(),
  videos: z.array(z.string()),
  /** Ссылки продуктов с метками (GetCourse): `{ url, title, campaign }`. Пустой список — оплату не отслеживать. */
  productLinks: z.array(productLinkSchema),
  /** Ссылка с подставленным текстом `{ template, types, maxTextLength }`; null — убрать. */
  textLink: textLinkSchema.nullable(),
  /** Сценарий SDK целиком: поля в нём — по названиям. */
  flow: z.record(z.string(), z.unknown()),
  // Старый вид: только при создании, переводится в сценарий (шаблоны и eval прежнего формата)
  stages: z.array(stageInput),
  fields: z.array(fieldInput),
  viewsLinks: z.boolean(),
  program: programInput.nullable(),
};
const LEGACY_KEYS = ["stages", "fields", "viewsLinks", "program"] as const;
const KEYS = Object.keys(inputShape);
const agentInput = z.object(inputShape).partial();
export type AgentInput = z.infer<typeof agentInput>;

const typeNames: Record<string, string> = {
  string: "строкой",
  number: "числом",
  array: "списком",
  object: "объектом",
  boolean: "true или false",
  null: "null",
};

function issueText(issue: z.core.$ZodIssue): string {
  const where = issue.path.length > 0 ? `«${issue.path.join(".")}»` : "Вход";
  if (issue.code === "invalid_type") return `${where} должно быть ${typeNames[issue.expected] ?? issue.expected}`;
  if (issue.code === "invalid_value") return `${where}: допустимо ${issue.values.map(String).join(", ")}`;
  if (issue.code === "unrecognized_keys") return `${where}: лишние ключи ${issue.keys.join(", ")}`;
  if (issue.code === "invalid_union") return `${where}: ожидается название поля строкой или объект { name, type, options, description }`;
  return `${where}: ${issue.message}`;
}

/** Ключи «//…» — пояснения в JSON (как в docs/lead-magnet-template.json): команда их пропускает на любой глубине. */
function withoutComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutComments);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith("//"))
      .map(([key, inner]) => [key, withoutComments(inner)]),
  );
}

/** Разбирает JSON со stdin. Неизвестные ключи и неверные типы — понятной ошибкой. */
export function parseAgentInput(text: string): AgentInput {
  let raw: unknown;
  try {
    raw = withoutComments(JSON.parse(text));
  } catch {
    throw new CliInputError("На входе не JSON: передайте объект настроек через stdin, например lm.sh update <id> < правка.json");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CliInputError("На входе должен быть JSON-объект настроек");
  const unknown = Object.keys(raw).filter((key) => !KEYS.includes(key));
  if (unknown.length > 0) {
    const hint = unknown.includes("settings") ? " Из вывода show передавайте содержимое settings, а не весь ответ." : "";
    throw new CliInputError(`Неизвестные ключи: ${unknown.join(", ")}. Допустимые: ${KEYS.join(", ")}.${hint}`);
  }
  const parsed = agentInput.safeParse(raw);
  if (!parsed.success) throw new CliInputError(parsed.error.issues.map(issueText).join("; "));
  return parsed.data;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Поля по названию: из словаря подключаются, новые создаются (как create_field конструктора). Порядок — как во входе. */
async function resolveFields(tx: DatabaseExecutor, input: NonNullable<AgentInput["fields"]>): Promise<string[]> {
  const dictionary = await listFields(tx);
  const ids: string[] = [];
  for (const item of input) {
    const wanted = typeof item === "string" ? { name: item } : item;
    const existing = dictionary.find((field) => sameName(field.name, wanted.name));
    if (existing) {
      if (wanted.type && wanted.type !== existing.type)
        throw new CliInputError(`Поле «${existing.name}» уже есть в словаре с типом ${existing.type}, а не ${wanted.type}`);
      if (!ids.includes(existing.id)) ids.push(existing.id);
      continue;
    }
    if (!wanted.type)
      throw new CliInputError(
        `Поля «${wanted.name}» нет в словаре. Чтобы создать его, передайте объект с type (${FIELD_TYPES.join(", ")}) и description`,
      );
    const created = await createField(tx, { name: wanted.name, type: wanted.type, options: wanted.options, description: wanted.description ?? "" });
    dictionary.push(created);
    ids.push(created.id);
  }
  return ids;
}

/** Ролики по названию из архива. Ненайденный или неоднозначный — ошибка со списком архива. */
async function resolveVideos(tx: DatabaseExecutor, titles: string[]): Promise<string[]> {
  const archive = await listVideos(tx);
  const available = () =>
    archive.length > 0 ? `В архиве: ${archive.map((video) => `«${video.title}»`).join(", ")}` : "Архив роликов пуст";
  return [
    ...new Set(
      titles.map((title) => {
        const found = archive.filter((video) => sameName(video.title, title));
        if (found.length === 0) throw new CliInputError(`Ролика «${title.trim()}» нет в архиве. ${available()}`);
        if (found.length > 1) throw new CliInputError(`В архиве несколько роликов «${title.trim()}»: переименуйте их в кабинете`);
        return found[0]!.id;
      }),
    ),
  ];
}

/**
 * Накладывает вход агента на настройки. `creating` — новый лидмагнит: можно передать и старый вид (этапы, программа,
 * поля, просмотр ссылок) — он переводится в сценарий. В правке старый вид — ошибка: перевод стёр бы сценарий.
 */
export async function applyAgentInput(
  tx: DatabaseExecutor,
  base: LeadMagnetSettings,
  input: AgentInput,
  options: { creating: boolean },
): Promise<LeadMagnetSettings> {
  const { fields, videos, stages, program, viewsLinks, flow, instruction, textLink, ...plain } = input;
  const legacy = LEGACY_KEYS.filter((key) => input[key] !== undefined);
  if (legacy.length > 0 && flow !== undefined)
    throw new CliInputError(`Ключи ${legacy.join(", ")} — старый вид настроек, вместе с flow их не передают: этапы, программа и поля теперь в flow`);
  if (legacy.length > 0 && !options.creating)
    throw new CliInputError(
      `Ключи ${legacy.join(", ")} больше не правятся: этапы, программа, поля карточки и просмотр ссылок теперь в сценарии. Передайте flow целиком — его вид есть в выводе show`,
    );
  if (instruction !== undefined && flow !== undefined && flow.common !== undefined)
    throw new CliInputError("Основная инструкция передана дважды: ключом instruction и в flow.common. Оставьте одно");

  let next: LeadMagnetSettings = { ...base, ...plain };
  if (textLink === null) delete next.textLink;
  else if (textLink !== undefined) next.textLink = textLink;
  if (legacy.length > 0) {
    next = { ...next, ...(instruction !== undefined && { instruction }), ...(viewsLinks !== undefined && { viewsLinks }) };
    if (stages) next.stages = stages.map(({ id: _id, ...stage }) => ({ id: randomUUID(), startDay: null, isSale: false, ...stage }));
    if (fields) next.fieldIds = await resolveFields(tx, fields);
    if (program !== undefined) next.program = program === null ? null : await resolveProgram(tx, base.program, program, next.fieldIds);
    next.flow = leadMagnetToFlow(next, await listFields(tx));
  } else if (flow !== undefined) {
    const resolved = await resolveFlow(tx, flow, base.flow);
    next = withLeadMagnetFlow(next, instruction === undefined ? resolved : { ...resolved, common: instruction });
  } else if (instruction !== undefined) next = withLeadMagnetFlow(next, { ...next.flow, common: instruction });
  if (videos) next.videoIds = await resolveVideos(tx, videos);
  return next;
}

type Json = Record<string, unknown>;

const cardFieldInput = z.union([
  z.string(),
  z.object({
    name: z.string(),
    type: z.enum(FIELD_TYPES).optional(),
    options: z.array(z.string()).optional(),
    about: z.string().optional(),
    refreshAfterMonths: z.number().nullable().optional(),
  }),
]);

const fieldKey = (name: string) => name.trim().toLowerCase();

/** Поля в сценарии: в карточке, попутных задачах, «узнать здесь» и условиях по данным. `rename` меняет каждое. */
function mapFieldRefs(json: Json, rename: (field: string) => string): Json {
  const exit = (item: unknown) => {
    const one = item as { when?: { type?: string; field?: unknown } };
    return one.when?.type === "data" && typeof one.when.field === "string" ? { ...one, when: { ...one.when, field: rename(one.when.field) } } : item;
  };
  const exits = (list: unknown) => (Array.isArray(list) ? list.map(exit) : list);
  const result: Json = { ...json };
  if (Array.isArray(json.states))
    result.states = json.states.map((state: Json) => ({
      ...state,
      ...(Array.isArray(state.learn) && { learn: state.learn.map((field) => (typeof field === "string" ? rename(field) : field)) }),
      ...(state.exits !== undefined && { exits: exits(state.exits) }),
    }));
  const anyState = json.anyState as Json | undefined;
  if (anyState && typeof anyState === "object") result.anyState = { ...anyState, exits: exits(anyState.exits) };
  if (Array.isArray(json.sideTasks))
    result.sideTasks = json.sideTasks.map((task: Json) => (typeof task.field === "string" ? { ...task, field: rename(task.field) } : task));
  return result;
}

/**
 * Сценарий из входа агента: поля карточки по названию (из словаря подключаются, новые создаются), ссылки на поля
 * в задачах и условиях — тоже по названию. Ошибка формы — с путём от корня настроек.
 */
async function resolveFlow(tx: DatabaseExecutor, input: Json, current: AgentFlow): Promise<AgentFlow> {
  const dictionary = await listFields(tx);
  const card: Array<{ id: string; refreshAfterMonths: number | null }> = [];
  const idByName = new Map<string, string>();
  const items = input.clientCard === undefined ? [] : Array.isArray(input.clientCard) ? input.clientCard : null;
  if (items === null) throw new CliInputError("«flow.clientCard» должно быть списком полей");
  for (const [index, item] of items.entries()) {
    const parsed = cardFieldInput.safeParse(item);
    if (!parsed.success)
      throw new CliInputError(`«flow.clientCard[${index}]»: ожидается название поля строкой или объект { name, type, options, about }`);
    const wanted = typeof parsed.data === "string" ? { name: parsed.data } : parsed.data;
    let field = dictionary.find((one) => fieldKey(one.name) === fieldKey(wanted.name));
    if (field && wanted.type && wanted.type !== field.type)
      throw new CliInputError(`Поле «${field.name}» уже есть в словаре с типом ${field.type}, а не ${wanted.type}`);
    if (!field) {
      if (!wanted.type)
        throw new CliInputError(
          `Поля «${wanted.name}» нет в словаре. Чтобы создать его, передайте в flow.clientCard объект с type (${FIELD_TYPES.join(", ")}) и about`,
        );
      field = await createField(tx, { name: wanted.name, type: wanted.type, options: wanted.options, description: wanted.about ?? "" });
      dictionary.push(field);
    }
    if (card.some((one) => one.id === field.id)) continue;
    card.push({ id: field.id, refreshAfterMonths: (typeof wanted === "object" && "refreshAfterMonths" in wanted && wanted.refreshAfterMonths) || null });
    idByName.set(fieldKey(field.name), field.id);
  }

  const renamed = mapFieldRefs({ ...input, clientCard: card.map((one) => one.id) }, (name) => idByName.get(fieldKey(name)) ?? name);
  const parsed = parseFlow(completeFlowJson(renamed, current));
  if (!parsed.ok) throw new CliInputError(parsed.errors.map((error) => `«flow${error.path ? `.${error.path}` : ""}»: ${error.message}`).join("; "));
  const refresh = new Map(card.map((one) => [one.id, one.refreshAfterMonths]));
  const flow = { ...parsed.flow, clientCard: parsed.flow.clientCard.map((field) => ({ ...field, refreshAfterMonths: refresh.get(field.id) ?? null })) };
  const withCard = cardFromDictionary(flow, dictionary);
  if (!withCard.ok) throw new Error(`Поля карточки пропали из словаря: ${withCard.missing.join(", ")}`);
  return withCard.flow;
}

/** Программа из входа агента: недостающее — прежнее значение или умолчание; поля попутных задач — по названию среди подключённых. */
async function resolveProgram(
  tx: DatabaseExecutor,
  previous: ProgramSettings | null,
  input: NonNullable<AgentInput["program"]>,
  connectedFieldIds: string[],
): Promise<ProgramSettings> {
  const days = input.days ?? previous?.days;
  if (days === undefined) throw new CliInputError("В «program» не указан срок: days — число дней, от 2 до 14");
  const start = previous ?? newProgramSettings(days);
  let sideTasks = start.sideTasks;
  if (input.sideTasks) {
    const dictionary = (await listFields(tx)).filter((field) => connectedFieldIds.includes(field.id));
    sideTasks = input.sideTasks.map(({ task, field, when }) => {
      const found = field ? dictionary.find((one) => sameName(one.name, field)) : null;
      if (field && !found)
        throw new CliInputError(`Поле «${field.trim()}» попутной задачи не подключено к лидмагниту: добавьте его в «fields»`);
      return { id: randomUUID(), task, fieldId: found?.id ?? null, when: when ?? "" };
    });
  }
  return {
    days,
    softDailyMessages: input.softDailyMessages ?? start.softDailyMessages,
    hardDailyMessages: input.hardDailyMessages ?? start.hardDailyMessages,
    outreach: { ...start.outreach, ...input.outreach },
    sideTasks,
  };
}

/** Сценарий для агента: без значений по умолчанию и раскладки доски, поля — по названиям. */
function flowForAgent(flow: AgentFlow, dictionary: readonly FieldDefinition[]): Json {
  const nameOf = (id: string) => dictionary.find((one) => one.id === id)?.name ?? id;
  const { layout: _layout, ...compact } = compactFlow(flow);
  const clientCard: AgentCardField[] = flow.clientCard.map((field) => ({
    name: nameOf(field.id),
    type: field.type,
    ...(field.type === "choice" && { options: field.options }),
    about: field.about,
    ...(field.refreshAfterMonths !== null && { refreshAfterMonths: field.refreshAfterMonths }),
  }));
  return mapFieldRefs({ ...compact, ...(clientCard.length > 0 && { clientCard }) }, nameOf);
}

/** Настройки так, как их показывает команда: сценарий, поля и ролики по названиям. */
export async function toAgentSettings(db: DatabaseExecutor, settings: LeadMagnetSettings): Promise<AgentSettings> {
  const dictionary = await listFields(db);
  return {
    name: settings.name,
    cardDescription: settings.cardDescription,
    firstMessage: settings.firstMessage,
    providerId: settings.providerId,
    modelId: settings.modelId,
    reasoning: settings.reasoning,
    endCondition: settings.endCondition,
    farewellMessage: settings.farewellMessage,
    maxPersonMessages: settings.maxPersonMessages,
    flow: flowForAgent(settings.flow, dictionary),
    videos: (await getVideos(db, settings.videoIds)).map((video) => video.title),
    productLinks: settings.productLinks ?? [],
    textLink: settings.textLink ?? null,
  };
}
