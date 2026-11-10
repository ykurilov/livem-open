import { randomUUID } from "node:crypto";
import { APP_STATE_PART_TYPE, foldAppState, loadCurrentBranch, type ChatStorage, type StoredMessage } from "@ykurilov/agent-chat-core";
import { FLOW_STATE_KEY } from "@ykurilov/agent-chat-flows";
import { compactFlow, parseFlow, type AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { asSchema, jsonSchema, tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  cardFromDictionary,
  clientCardFieldOf,
  completeFlowJson,
  CONVERSATION_NUDGES,
  LEAD_MAGNET_TOOLS,
  leadMagnetFlowIssues,
  scheduleWithDefaults,
  withLeadMagnetFlow,
} from "../flows";
import {
  getLeadMagnet,
  InvalidLeadMagnetSettingsError,
  LeadMagnetNotFoundError,
  lockLeadMagnet,
  saveDraft,
  validateLeadMagnetSettings,
  type LeadMagnetSettings,
} from "../lead-magnets";
import { createField, getFields, InvalidFieldError, listFields, FIELD_TYPES } from "../people";
import { buildConsultantInstruction } from "../consultant/instruction";
import { isOutreachRequest } from "../consultant/outreach-request";
import { assistantHandoffIn, botDirectionIn, greetingDirectionIn } from "./bot-directed-text";
import { textLinkSchema } from "../text-links/text-link";
import { describeEditInputIssues } from "./edit-input-hints";
import { withoutDeletedFields } from "./manual-edits";
import { ANSWER_CORRECTION_TOOL_NAMES, createAnswerCorrectionTools } from "./answer-corrections";
import type { Database, DatabaseExecutor } from "../platform/db";

export const CONSTRUCTOR_TOOL_NAMES = [
  "view_lead_magnet",
  "edit_lead_magnet",
  "read_test_conversation",
  "reopen_test_conversation",
  ...ANSWER_CORRECTION_TOOL_NAMES,
] as const;

export interface ConstructorToolDependencies {
  db: Database;
  chatStorage: ChatStorage;
  /** Продолжить завершённый тестовый разговор лидмагнита (служба «Проверки»). */
  reopenTestConversation?: (leadMagnetId: string) => Promise<void>;
}

export type ToolResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

// Провайдер, модель и уровень рассуждения меняет только эксперт в настройках: их в схеме нет.
const textFields = ["name", "cardDescription", "clientPortrait", "instruction", "firstMessage", "endCondition", "farewellMessage"] as const;
// Кусочком правятся только длинные тексты (contracts/agent-tools.md)
const fragmentFields = ["instruction", "firstMessage", "endCondition", "farewellMessage"] as const;

/** Поле из списка; имя «first_message» вместо «firstMessage» — ошибка называет правильное. */
function fieldName<const T extends readonly [string, ...string[]]>(allowed: T) {
  return z.enum(allowed, {
    error: ({ input }) => {
      const camel = String(input).replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return allowed.includes(camel) && camel !== input
        ? `Поле называется «${camel}», а не «${String(input)}»`
        : `Нет поля «${String(input)}». Поля: ${allowed.join(", ")}`;
    },
  });
}

/** Кусок сценария в формате SDK: объект или строка JSON. Значения по умолчанию можно не писать. */
const flowJson = (what: string) => z.union([z.record(z.string(), z.unknown()), z.string()]).describe(what);

const change = z.union([
  z.strictObject({ op: z.literal("set"), field: fieldName(textFields), value: z.string() }).describe("Заменить текстовое поле целиком"),
  z.strictObject({ op: z.literal("set"), field: z.literal("maxPersonMessages"), value: z.number().int() }),
  z
    .strictObject({ op: z.literal("replace_fragment"), field: fieldName(fragmentFields), find: z.string().min(1), replace: z.string() })
    .describe("Заменить кусок текста; кусок должен встречаться в поле ровно 1 раз"),
  z
    .strictObject({ op: z.literal("replace_fragment"), stateId: z.string(), find: z.string().min(1), replace: z.string() })
    .describe("Заменить кусок инструкции ноды; кусок должен встречаться в ней ровно 1 раз"),
  z
    .strictObject({
      op: z.literal("put_flow"),
      flow: flowJson("Сценарий agent-flow версии 2 целиком: start, anyState, states, schedule, nudges, sideTasks, clientCard. «Общее» — это основная инструкция, его можно не писать. Без clientCard и chatNotes карточка клиента и заметки чата остаются как есть"),
    })
    .describe("Заменить весь сценарий: для первой сборки или большой переделки"),
  z
    .strictObject({
      op: z.literal("put_state"),
      state: flowJson("Нода целиком: id, title, instructions (первая строка — цель), exits, tags, tools, nudges"),
      afterStateId: z.string().optional().describe("Новую ноду вставить после этой; не задано — перед конечными"),
    })
    .describe("Добавить ноду или заменить ноду с тем же id"),
  z.strictObject({ op: z.literal("remove_state"), stateId: z.string() }).describe("Убрать ноду и все выходы в неё"),
  z.strictObject({ op: z.literal("set_start"), stateId: z.string() }).describe("Стартовая нода"),
  z
    .strictObject({ op: z.literal("put_schedule"), schedule: flowJson("«Дни и время» целиком: dayStart, nightFrom, lengthDays, deadlineState, firstMessages, nudges, dayFrame, farewellOnDeadline, farewellText") })
    .describe("Включить воронку на несколько дней или заменить её «Дни и время»"),
  z.strictObject({ op: z.literal("remove_schedule") }).describe("Вернуть лидмагнит к одному разговору: «Дни и время» убираются"),
  z
    .strictObject({
      op: z.literal("put_side_tasks"),
      sideTasks: z.array(flowJson("Попутная задача: text, when, field (id поля карточки); id можно не писать")),
    })
    .describe("Попутные задачи списком целиком"),
  z
    .strictObject({
      op: z.literal("set_text_link"),
      textLink: z
        .union([
          z.strictObject({
            template: z.string().describe("HTTPS-шаблон эксперта с обязательной подстановкой {text} и необязательной {type}"),
            types: z.array(z.string()).optional().describe("Допустимые значения {type}; нет — без типа"),
            maxTextLength: z.number().int().describe("Предел текста в знаках по ограничениям сервиса, не больше 1200"),
            say: z.string().optional().describe("Назначение ссылки и действие, которое требуется от человека"),
          }),
          z.null(),
        ])
        .describe("null — убрать"),
    })
    .describe("Ссылка с подставленным текстом: сервис эксперта открывается с уже вписанным текстом; консультант собирает её инструментом"),
  z.strictObject({ op: z.literal("attach_field"), fieldId: z.string() }).describe("Подключить поле словаря к карточке клиента"),
  z.strictObject({ op: z.literal("detach_field"), fieldId: z.string() }),
  z
    .strictObject({
      op: z.literal("create_field"),
      name: z.string().min(1),
      type: z.enum(FIELD_TYPES),
      options: z.array(z.string()).optional().describe("Варианты — только для type=choice"),
      description: z.string(),
    })
    .describe("Завести новое поле в общем словаре и подключить его к карточке клиента"),
]);

export const editLeadMagnetInput = z.strictObject({ changes: z.array(change).min(1) });
export type EditLeadMagnetInput = z.infer<typeof editLeadMagnetInput>;

/**
 * Вход edit_lead_magnet для модели: схема та же, что у `editLeadMagnetInput` (модель видит массив, запрос и кэш не меняются).
 * `changes` строкой JSON схема отклоняет: строку разбирает и чинит ядро SDK, затем вызов проверяется заново.
 * Неверные правки массивом схема пропускает: короткую ошибку о них даёт сам инструмент (`describeEditInputIssues`).
 */
const editLeadMagnetToolInput = (() => {
  const base = asSchema(editLeadMagnetInput);
  return jsonSchema<EditLeadMagnetInput>(() => base.jsonSchema, {
    validate: async (value) => {
      const result = await base.validate!(value);
      if (result.success || typeof value !== "object" || value === null || Array.isArray(value)) return result;
      if ("changes" in value && typeof value.changes === "string") return result;
      return { success: true, value: value as EditLeadMagnetInput };
    },
  });
})();
type Change = EditLeadMagnetInput["changes"][number];

class ChangeRejected extends Error {}

/** Вхождения с перекрытием: «aa» в «aaa» — два раза. */
function countOccurrences(text: string, fragment: string): number {
  let count = 0;
  for (let at = text.indexOf(fragment); at !== -1; at = text.indexOf(fragment, at + 1)) count++;
  return count;
}

function replaceOnce(text: string, find: string, replace: string, where: string): string {
  const count = countOccurrences(text, find);
  if (count !== 1) throw new ChangeRejected(`В ${where} кусок «${find}» встречается ${count} раз, а нужно ровно 1 раз`);
  return text.replace(find, () => replace);
}

type Json = Record<string, unknown>;

function jsonOf(value: Json | string, what: string): Json {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Json;
  } catch {
    // ниже — общая ошибка
  }
  throw new ChangeRejected(`${what}: нужен JSON-объект`);
}

/** Сценарий после правки: разобран со значениями по умолчанию; ошибка формы — с путём. Связи проверяются в конце. */
function reparsed(json: Json): AgentFlow {
  const parsed = parseFlow(json);
  if (parsed.ok) return parsed.flow;
  throw new ChangeRejected(parsed.errors.map((error) => `«flow${error.path ? `.${error.path}` : ""}»: ${error.message}`).join("; "));
}

function stateIndex(flow: AgentFlow, stateId: string): number {
  const index = flow.states.findIndex((state) => state.id === stateId);
  if (index < 0) throw new ChangeRejected(`Нет ноды с id «${stateId}»`);
  return index;
}

/** Правка сценария через JSON: так нода или «Дни и время» проходят тот же разбор, что и сценарий целиком. */
function editFlow(flow: AgentFlow, edit: (json: Json & { states: Json[] }) => void): AgentFlow {
  const json = structuredClone(flow) as unknown as Json & { states: Json[] };
  edit(json);
  return reparsed(json);
}

function applyFlowChange(flow: AgentFlow, item: Change): AgentFlow {
  switch (item.op) {
    case "put_flow": {
      // Служебное — из текущего сценария: «Общее» правится своей операцией, раскладку двигает эксперт на доске.
      // Карточка клиента без clientCard — прежняя: поля заводят create_field и attach_field, а не сценарий
      const next = reparsed(completeFlowJson({ clientCard: flow.clientCard, ...jsonOf(item.flow, "Сценарий") }, flow));
      const ids = new Set(next.states.map((state) => state.id));
      const layout = Object.fromEntries(Object.entries(flow.layout).filter(([id]) => ids.has(id)));
      return { ...next, id: flow.id, name: flow.name, common: flow.common, layout };
    }
    case "put_state": {
      const state = jsonOf(item.state, "Нода");
      if (typeof state.id !== "string" || !state.id) throw new ChangeRejected("У ноды нужен id");
      return editFlow(flow, (json) => {
        const existing = flow.states.findIndex((one) => one.id === state.id);
        if (existing >= 0) json.states[existing] = state;
        else {
          // Новая нода — после указанной или перед конечными: на доске и в списке она встаёт по ходу разговора
          const lastWorking = flow.states.findLastIndex((one) => one.exits.length > 0);
          const at = item.afterStateId === undefined ? lastWorking + 1 : stateIndex(flow, item.afterStateId) + 1;
          json.states.splice(at, 0, state);
        }
      });
    }
    case "remove_state": {
      stateIndex(flow, item.stateId);
      if (flow.start === item.stateId) throw new ChangeRejected(`Нода «${item.stateId}» — стартовая: сначала назначьте другую (set_start)`);
      const exits = <T extends { to: string | null }>(list: T[]) => list.filter((exit) => exit.to !== item.stateId);
      const { [item.stateId]: _place, ...layout } = flow.layout;
      return {
        ...flow,
        states: flow.states.filter((state) => state.id !== item.stateId).map((state) => ({ ...state, exits: exits(state.exits) })),
        anyState: { except: flow.anyState.except.filter((id) => id !== item.stateId), exits: exits(flow.anyState.exits) },
        layout,
      };
    }
    case "set_start":
      stateIndex(flow, item.stateId);
      return { ...flow, start: item.stateId };
    case "put_schedule":
      return editFlow(flow, (json) => {
        json.schedule = scheduleWithDefaults(jsonOf(item.schedule, "«Дни и время»"));
      });
    case "remove_schedule": {
      const { schedule: _schedule, ...rest } = flow;
      // Без «Дней и времени» напоминания бросившим идут общими касаниями сценария
      return { ...rest, nudges: flow.nudges ?? CONVERSATION_NUDGES };
    }
    case "put_side_tasks":
      return editFlow(flow, (json) => {
        json.sideTasks = item.sideTasks.map((task) => {
          const value = jsonOf(task, "Попутная задача");
          return { id: randomUUID(), ...value };
        });
      });
    default:
      throw new Error(`Не правка сценария: ${item.op}`);
  }
}

async function applyChange(tx: DatabaseExecutor, settings: LeadMagnetSettings, item: Change): Promise<LeadMagnetSettings> {
  const flow = settings.flow;
  switch (item.op) {
    case "set":
      // Основная инструкция — это «Общее» сценария
      if (item.field === "instruction") return withLeadMagnetFlow(settings, { ...flow, common: item.value });
      return { ...settings, [item.field]: item.value };
    case "replace_fragment": {
      if ("stateId" in item) {
        const index = stateIndex(flow, item.stateId);
        const state = flow.states[index]!;
        const instructions = replaceOnce(state.instructions, item.find, item.replace, `инструкции ноды «${state.title}»`);
        return { ...settings, flow: { ...flow, states: flow.states.map((one, i) => (i === index ? { ...one, instructions } : one)) } };
      }
      if (item.field === "instruction")
        return withLeadMagnetFlow(settings, { ...flow, common: replaceOnce(flow.common, item.find, item.replace, "поле instruction") });
      return { ...settings, [item.field]: replaceOnce(settings[item.field], item.find, item.replace, `поле ${item.field}`) };
    }
    case "set_text_link": {
      if (item.textLink === null) {
        const { textLink: _removed, ...rest } = settings;
        return rest;
      }
      const parsed = textLinkSchema.safeParse(item.textLink);
      if (!parsed.success) throw new ChangeRejected(`Ссылка с подставленным текстом: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
      return { ...settings, textLink: parsed.data };
    }
    case "attach_field": {
      const [field] = await getFields(tx, [item.fieldId]);
      if (!field) throw new ChangeRejected(`Нет поля с id «${item.fieldId}» в словаре`);
      if (flow.clientCard.some((one) => one.id === field.id)) return settings;
      return { ...settings, flow: { ...flow, clientCard: [...flow.clientCard, clientCardFieldOf(field)] } };
    }
    case "detach_field":
      return { ...settings, flow: { ...flow, clientCard: flow.clientCard.filter((one) => one.id !== item.fieldId) } };
    case "create_field": {
      const field = await createField(tx, item);
      return { ...settings, flow: { ...flow, clientCard: [...flow.clientCard, clientCardFieldOf(field)] } };
    }
    default:
      return { ...settings, flow: applyFlowChange(flow, item) };
  }
}

/** Карточка клиента — по словарю «Базы»; поля, которого там нет, быть не может. */
async function withCardFromDictionary(tx: DatabaseExecutor, settings: LeadMagnetSettings): Promise<LeadMagnetSettings> {
  const card = cardFromDictionary(settings.flow, await getFields(tx, settings.flow.clientCard.map((field) => field.id)));
  if (!card.ok)
    throw new ChangeRejected(
      `В карточке клиента поля ${card.missing.map((id) => `«${id}»`).join(", ")} нет в словаре: подключите поле из словаря (attach_field) или заведите новое (create_field)`,
    );
  return withLeadMagnetFlow(settings, card.flow);
}

/** Поле, заведённое этим вызовом, — в карточке, даже если следом put_flow прислал свою карточку без него. */
function keepCreatedFields(settings: LeadMagnetSettings, created: LeadMagnetSettings["flow"]["clientCard"]): LeadMagnetSettings {
  const card = settings.flow.clientCard;
  const lost = created.filter((field) => !card.some((one) => one.id === field.id));
  return lost.length === 0 ? settings : { ...settings, flow: { ...settings.flow, clientCard: [...card, ...lost] } };
}

type TextForPerson = { where: string; text: string; firstMessage: boolean };

/** Тексты, которые уходят человеку дословно, с местом для подсказки. */
function textsForPerson(settings: LeadMagnetSettings): TextForPerson[] {
  const { flow } = settings;
  return [
    { where: "первом сообщении", text: settings.firstMessage, firstMessage: true },
    ...flow.states.map((state) => ({ where: `первом сообщении ноды «${state.title}»`, text: state.firstMessage ?? "", firstMessage: true })),
    { where: "прощании", text: settings.farewellMessage, firstMessage: false },
    { where: "прощании при «срок вышел»", text: flow.schedule?.farewellText ?? "", firstMessage: false },
    { where: "фразе жёсткой рамки дня", text: flow.schedule?.dayFrame?.hardText ?? "", firstMessage: false },
  ];
}

/**
 * Текст для человека, который правка меняет, — готовый текст, а не указание консультанту и не «передал эксперту».
 * Старые тексты не проверяются: они не мешают другим правкам.
 */
function checkTextsForPerson(before: LeadMagnetSettings, after: LeadMagnetSettings): void {
  const old = new Map(textsForPerson(before).map((item) => [item.where, item.text]));
  for (const { where, text, firstMessage } of textsForPerson(after)) {
    if (!text.trim() || old.get(where) === text) continue;
    const direction = firstMessage ? greetingDirectionIn(text) : botDirectionIn(text);
    if (direction)
      throw new ChangeRejected(
        `В ${where} указание консультанту («${direction}»), а этот текст уходит человеку дословно. ` +
          "Напиши готовый текст от лица помощника. Указания консультанту должны быть в инструкции",
      );
    const handoff = assistantHandoffIn(text);
    if (handoff)
      throw new ChangeRejected(
        `В ${where} помощник «${handoff.charAt(0).toUpperCase() + handoff.slice(1)}» что-то эксперту, а помощник ничего не передаёт: эксперт видит разговор сам. ` +
          "Убери неподтверждённую передачу. Действия эксперта указывай только по подтверждённым условиям",
      );
  }
}

/** Ноды, у которых remove_state забрал последние выходы: такая нода становится концом разговора. */
function strandedBy(before: AgentFlow, after: AgentFlow): string[] {
  return after.states.filter((state) => state.exits.length === 0 && (before.states.find((one) => one.id === state.id)?.exits.length ?? 0) > 0).map((state) => state.id);
}

/** Нода, оставшаяся без выходов после удаления соседней, — ошибка, если правка не дала ей новых выходов. */
function checkStrandedStates(flow: AgentFlow, stranded: readonly string[]): void {
  const ends = flow.states.filter((state) => stranded.includes(state.id) && state.exits.length === 0);
  if (ends.length === 0) return;
  const names = ends.map((state) => `«${state.title.trim() || state.id}»`).join(", ");
  throw new ChangeRejected(
    `${names} — без выходов после удаления ноды: разговор закончится там, и клиент дальше не пойдёт. ` +
      `Дай ей выход в той же правке (put_state): в следующую ноду или в «Итог» по ${LEAD_MAGNET_TOOLS.finishDialog}`,
  );
}

/** Применяет все изменения разом: одна версия «constructor» или ничего, если хоть одно изменение не подошло. */
export async function editLeadMagnet(
  deps: ConstructorToolDependencies,
  leadMagnetId: string,
  input: EditLeadMagnetInput,
): Promise<ToolResult<{ versionId: string }>> {
  try {
    const version = await deps.db.transaction(async (tx) => {
      const lead = await lockLeadMagnet(tx, leadMagnetId);
      let settings = lead.draft;
      let created: LeadMagnetSettings["flow"]["clientCard"] = [];
      let stranded: string[] = [];
      for (const item of input.changes) {
        const before = settings.flow.clientCard.length;
        const flowBefore = settings.flow;
        settings = await applyChange(tx, settings, item);
        if (item.op === "remove_state") stranded = [...stranded, ...strandedBy(flowBefore, settings.flow)];
        if (item.op === "create_field") created = [...created, ...settings.flow.clientCard.slice(before)];
        if (item.op === "detach_field") created = created.filter((field) => field.id !== item.fieldId);
      }
      checkStrandedStates(settings.flow, stranded);
      checkTextsForPerson(lead.draft, settings);
      // Поле, удалённое из словаря после прошлой правки, уходит из черновика, а не запрещает следующие правки
      settings = await withCardFromDictionary(tx, await withoutDeletedFields(tx, keepCreatedFields(settings, created)));
      return saveDraft(tx, leadMagnetId, validateLeadMagnetSettings(settings), "constructor");
    });
    return { ok: true, versionId: version.id };
  } catch (error) {
    if (
      error instanceof ChangeRejected ||
      error instanceof InvalidLeadMagnetSettingsError ||
      error instanceof InvalidFieldError ||
      error instanceof LeadMagnetNotFoundError
    )
      return { ok: false, error: `${error.message}. Ничего не изменено.` };
    throw error;
  }
}

export const VIEW_SECTIONS = [
  "overview",
  "instruction",
  "firstMessage",
  "flow",
  "ending",
  "fields",
  "fieldDictionary",
  "modelInfo",
  "appRules",
] as const;
export type ViewSection = (typeof VIEW_SECTIONS)[number];

/**
 * Сценарий для конструктора: без значений по умолчанию, без «Общего» (это раздел instruction) и раскладки доски;
 * ошибки и замечания проверки — если есть.
 */
function flowView(flow: AgentFlow): Json {
  const { common: _common, layout: _layout, ...compact } = compactFlow(flow);
  const issues = leadMagnetFlowIssues(flow);
  return issues.length > 0 ? { ...compact, issues } : compact;
}

export async function viewLeadMagnet(
  deps: ConstructorToolDependencies,
  leadMagnetId: string,
  input: { sections: readonly ViewSection[] },
): Promise<Partial<Record<ViewSection, unknown>>> {
  const lead = await getLeadMagnet(deps.db, leadMagnetId);
  if (!lead) throw new Error(`Лидмагнит ${leadMagnetId} не найден`);
  const draft = lead.draft;
  const view: Partial<Record<ViewSection, unknown>> = {};
  for (const section of new Set(input.sections)) {
    switch (section) {
      case "overview":
        view.overview = {
          name: draft.name,
          cardDescription: draft.cardDescription,
          // «Описание клиентов»: консультант его не видит, по нему играется агент-клиент «Поменяемся ролями»
          clientPortrait: draft.clientPortrait,
          maxPersonMessages: draft.maxPersonMessages,
          stateCount: draft.flow.states.length,
          days: draft.flow.schedule?.lengthDays ?? null,
          fieldCount: draft.flow.clientCard.length,
          published: lead.publishedSnapshotId !== null,
          textLink: draft.textLink ?? null,
        };
        break;
      case "instruction":
        view.instruction = draft.flow.common;
        break;
      case "firstMessage":
        view.firstMessage = draft.firstMessage;
        break;
      case "flow":
        view.flow = flowView(draft.flow);
        break;
      case "ending":
        view.ending = { endCondition: draft.endCondition, farewellMessage: draft.farewellMessage };
        break;
      case "fields":
        view.fields = await getFields(deps.db, draft.flow.clientCard.map((field) => field.id));
        break;
      case "fieldDictionary":
        view.fieldDictionary = await listFields(deps.db);
        break;
      case "modelInfo":
        view.modelInfo = { providerId: draft.providerId, modelId: draft.modelId, reasoning: draft.reasoning };
        break;
      // Правила, которые приложение добавляет консультанту само: эксперт их не меняет, новое правило с ними сверяется
      case "appRules":
        view.appRules = buildConsultantInstruction(draft);
        break;
    }
  }
  return view;
}

function textOf(message: StoredMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

/** Нода сценария после сообщения: SDK пишет место чата записью состояния (`FLOW_STATE_KEY`) в сообщения ветки. */
function stateAfter(values: Record<string, unknown>, message: StoredMessage): { values: Record<string, unknown>; state: string | null } {
  // Свёртка копирует состояние: сообщения без записей состояния его не меняют
  const next = message.parts.some((part) => part.type === APP_STATE_PART_TYPE) ? foldAppState([message], values) : values;
  const run = next[FLOW_STATE_KEY] as { state?: unknown } | undefined;
  return { values: next, state: typeof run?.state === "string" ? run.state : null };
}

/** Тестовый разговор текстом: реплики по порядку и отметки этапов. */
export async function readTestConversation(
  deps: ConstructorToolDependencies,
  leadMagnetId: string,
  input: { lastMessages?: number },
): Promise<string> {
  const lead = await getLeadMagnet(deps.db, leadMagnetId);
  if (!lead) throw new Error(`Лидмагнит ${leadMagnetId} не найден`);
  const chatId = lead.previewChatId;
  const messages = chatId && (await deps.chatStorage.getChat(chatId)) ? await loadCurrentBranch(deps.chatStorage, chatId) : [];
  if (messages.length === 0) return "Тестового разговора ещё не было.";

  const { flow } = lead.draft;
  const stageName = new Map(flow.states.map((state) => [state.id, state.title]));
  // Строка — одна реплика с отметкой ноды, в которой она прозвучала. Сценарий из одной ноды — без отметок
  const lines: Array<{ stage: string | null; text: string }> = [];
  const marked = flow.states.filter((state) => state.exits.length > 0).length > 1;
  let stage = marked ? flow.start : null;
  let values: Record<string, unknown> = {};
  for (const message of messages) {
    const after = stateAfter(values, message);
    values = after.values;
    if (marked && after.state) stage = after.state;
    // Просьба «напиши первым» — служебная, человек её не писал; ответ на неё — реплика консультанта
    if (isOutreachRequest(message)) continue;
    const text = textOf(message);
    if (!text) continue;
    lines.push({ stage, text: `${message.role === "user" ? "Человек" : "Консультант"}: ${text}` });
  }

  const shown = input.lastMessages ? lines.slice(-input.lastMessages) : lines;
  const out: string[] = [];
  let lastStage: string | null | undefined;
  for (const line of shown) {
    if (line.stage !== null && line.stage !== lastStage) out.push(`[этап: ${stageName.get(line.stage) ?? line.stage}]`);
    lastStage = line.stage;
    out.push(line.text);
  }
  return out.join("\n");
}

/**
 * Инструменты конструктора, привязанные к одному лидмагниту (id или функция, которая найдёт его по чату).
 * `onChange` — черновик изменён или правки ответов разобраны.
 */
export function createConstructorTools(
  deps: ConstructorToolDependencies,
  leadMagnet: string | (() => Promise<string>),
  onChange: () => void = () => {},
): ToolSet {
  const leadMagnetId = typeof leadMagnet === "string" ? async () => leadMagnet : leadMagnet;
  return {
    view_lead_magnet: tool({
      description:
        "Посмотреть текущий черновик лидмагнита. Выбирай только нужные разделы. " +
        "appRules — правила, которые приложение само добавляет консультанту поверх настроек эксперта; их не меняет никто.",
      inputSchema: z.strictObject({ sections: z.array(z.enum(VIEW_SECTIONS)).min(1) }),
      execute: async (input) => viewLeadMagnet(deps, await leadMagnetId(), input),
    }),
    edit_lead_magnet: tool({
      description:
        "Изменить черновик лидмагнита. Все изменения одного вызова применяются вместе и дают одну версию; " +
        "если хоть одно не подошло, не применяется ничего. Модель и провайдера здесь не поменять.",
      inputSchema: editLeadMagnetToolInput,
      execute: async (input) => {
        const parsed = editLeadMagnetInput.safeParse(input);
        if (!parsed.success) return { ok: false, error: describeEditInputIssues(input, change.options) } satisfies ToolResult;
        const result = await editLeadMagnet(deps, await leadMagnetId(), parsed.data);
        if (result.ok) onChange();
        return result;
      },
    }),
    read_test_conversation: tool({
      description: "Прочитать тестовый разговор эксперта с консультантом: реплики и этапы.",
      inputSchema: z.strictObject({ lastMessages: z.number().int().min(1).optional() }),
      execute: async (input) => readTestConversation(deps, await leadMagnetId(), input),
    }),
    reopen_test_conversation: tool({
      description:
        "Снять блокировку с завершённого тестового разговора: эксперт сможет писать консультанту дальше с того места, где разговор кончился.",
      inputSchema: z.strictObject({}),
      execute: async (): Promise<ToolResult> => {
        if (!deps.reopenTestConversation) return { ok: false, error: "Тестовый разговор отсюда недоступен" };
        await deps.reopenTestConversation(await leadMagnetId());
        return { ok: true };
      },
    }),
    ...createAnswerCorrectionTools(deps.db, leadMagnetId, onChange),
  };
}
