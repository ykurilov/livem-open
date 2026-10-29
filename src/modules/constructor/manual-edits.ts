import type { AgentFlow, FlowCondition, FlowDuration, FlowExit, FlowNudges, FlowState } from "@ykurilov/agent-chat-flows/format";
import { SALE_TAG, withLeadMagnetFlow } from "../flows";
import {
  appendManualEditNotes,
  getVersion,
  lockLeadMagnet,
  saveDraft,
  validateLeadMagnetSettings,
  type LeadMagnet,
  type LeadMagnetSettings,
  type LeadMagnetVersion,
  type VersionSource,
} from "../lead-magnets";
import { deletedFieldIds, getFields } from "../people";
import { getImages } from "../images";
import { getVideos } from "../videos";
import type { Database, DatabaseExecutor } from "../platform/db";
import { AGENT_TIME_ZONE } from "../platform/models-catalog";

const textLabels = {
  name: "Название",
  cardDescription: "Описание карточки",
  firstMessage: "Первое сообщение",
  endCondition: "Условие завершения",
  farewellMessage: "Прощальное сообщение",
} as const;

/** Текст короче — в заметку целиком; длиннее — только изменённый кусок с соседями. */
const WHOLE_TEXT_LIMIT = 120;
const CONTEXT = 40;

function quoteChange(before: string, after: string): string {
  if (before.length <= WHOLE_TEXT_LIMIT && after.length <= WHOLE_TEXT_LIMIT) return `было «${before}» → стало «${after}»`;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  const piece = (text: string) => {
    const from = Math.max(0, start - CONTEXT);
    const to = Math.min(text.length, text.length - end + CONTEXT);
    let changed = text.slice(from, to);
    if (changed.length > 2 * CONTEXT + 80) changed = `${changed.slice(0, CONTEXT + 40)}…${changed.slice(-CONTEXT - 40)}`;
    return `${from > 0 ? "…" : ""}${changed}${to < text.length ? "…" : ""}`;
  };
  return `было «${piece(before)}» → стало «${piece(after)}»`;
}

const UNITS: Record<FlowDuration["unit"], string> = { min: "мин", h: "ч", d: "дн." };
const duration = ({ amount, unit }: FlowDuration) => `${amount} ${UNITS[unit]}`;

function conditionText(when: FlowCondition): string {
  switch (when.type) {
    case "judge":
      return `судья: ${when.text}`;
    case "data":
      return `поле ${when.field} ${when.op}${when.value === undefined ? "" : ` ${String(when.value)}`}`;
    case "event":
      return when.event === "tool" ? `инструмент ${when.name ?? ""}`.trim() : `событие ${when.event}${when.name ? ` ${when.name}` : ""}`;
    case "timer":
      if (when.from === "state_days") return `нода длится ${when.days} дн.`;
      if (when.from === "time_of_day") return `в ${when.at}`;
      if (when.from === "program_day") return `с дня ${when.day} воронки`;
      return `${{ in_state: "в ноде", silence: "тишина", since_start: "с начала" }[when.from]} ${duration(when)}`;
  }
}

function nudgesText(nudges: FlowNudges | "off" | undefined): string {
  if (nudges === undefined) return "общие";
  if (nudges === "off") return "без касаний";
  const parts = [nudges.afterSilence.map(duration).join(", ") || "нет"];
  if (nudges.dailyAt?.length) parts.push(`каждый день в ${nudges.dailyAt.join(", ")}`);
  if (nudges.giveUpAfter) parts.push(`«не завершил» после ${duration(nudges.giveUpAfter)}`);
  return parts.join("; ");
}

const listText = (items: readonly string[]) => (items.length > 0 ? items.join(", ") : "нет");

function describeExits(prefix: string, before: FlowExit[], after: FlowExit[], title: (id: string | null) => string): string[] {
  const notes: string[] = [];
  const old = new Map(before.map((exit) => [exit.id, exit]));
  const now = new Map(after.map((exit) => [exit.id, exit]));
  for (const exit of before)
    if (!now.has(exit.id)) notes.push(`${prefix}: удалён переход в ${title(exit.to)} (${conditionText(exit.when)})`);
  for (const exit of after) {
    const was = old.get(exit.id);
    if (!was) {
      notes.push(`${prefix}: добавлен переход в ${title(exit.to)} (${conditionText(exit.when)})`);
      continue;
    }
    if (was.to !== exit.to) notes.push(`${prefix}: переход «${conditionText(exit.when)}» ведёт было в ${title(was.to)} → стало в ${title(exit.to)}`);
    if (conditionText(was.when) !== conditionText(exit.when))
      notes.push(`${prefix}, переход в ${title(exit.to)}: было «${conditionText(was.when)}» → стало «${conditionText(exit.when)}»`);
  }
  return notes;
}

function describeState(was: FlowState, state: FlowState, title: (id: string | null) => string): string[] {
  const notes: string[] = [];
  const prefix = `Нода «${state.title}»`;
  if (was.title !== state.title) notes.push(`Нода «${was.title}»: название ${quoteChange(was.title, state.title)}`);
  if (was.instructions !== state.instructions) notes.push(`${prefix}: инструкция ${quoteChange(was.instructions, state.instructions)}`);
  if ((was.firstMessage ?? "") !== (state.firstMessage ?? ""))
    notes.push(`${prefix}: сообщение при входе ${quoteChange(was.firstMessage ?? "", state.firstMessage ?? "")}`);
  const wasSale = was.tags.includes(SALE_TAG);
  const isSale = state.tags.includes(SALE_TAG);
  if (wasSale !== isSale) notes.push(isSale ? `${prefix}: отмечена как «Продажа»` : `${prefix}: отметка «Продажа» снята`);
  const otherTags = (tags: string[]) => listText(tags.filter((tag) => tag !== SALE_TAG));
  if (otherTags(was.tags) !== otherTags(state.tags)) notes.push(`${prefix}: метки было «${otherTags(was.tags)}» → стало «${otherTags(state.tags)}»`);
  if (listText(was.tools) !== listText(state.tools)) notes.push(`${prefix}: инструменты было «${listText(was.tools)}» → стало «${listText(state.tools)}»`);
  if (nudgesText(was.nudges) !== nudgesText(state.nudges)) notes.push(`${prefix}: касания было «${nudgesText(was.nudges)}» → стало «${nudgesText(state.nudges)}»`);
  notes.push(...describeExits(prefix, was.exits, state.exits, title));
  return notes;
}

function describeSchedule(before: AgentFlow["schedule"], after: AgentFlow["schedule"]): string[] {
  if (!before && !after) return [];
  if (!before) return [`Дни и время: включены${after!.lengthDays ? `, срок ${after!.lengthDays} дн.` : ""}`];
  if (!after) return ["Дни и время: выключены, разговор снова один"];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])] as Array<keyof typeof before>;
  const text = (value: unknown) => (value === undefined ? "нет" : typeof value === "object" ? JSON.stringify(value) : String(value));
  return keys.flatMap((key) =>
    text(before[key]) === text(after[key]) ? [] : [`Дни и время: ${key} было «${text(before[key])}» → стало «${text(after[key])}»`],
  );
}

function describeSideTasks(before: AgentFlow["sideTasks"], after: AgentFlow["sideTasks"], fieldNames: ReadonlyMap<string, string>): string[] {
  const notes: string[] = [];
  const fieldName = (id: string | undefined) => (id === undefined ? "нет" : (fieldNames.get(id) ?? "удалённое поле"));
  const old = new Map((before ?? []).map((task) => [task.id, task]));
  const now = new Map((after ?? []).map((task) => [task.id, task]));
  for (const task of before ?? []) if (!now.has(task.id)) notes.push(`Попутные задачи: удалена «${task.text}»`);
  for (const task of after ?? []) {
    const was = old.get(task.id);
    if (!was) {
      notes.push(`Попутные задачи: добавлена «${task.text}»${task.field ? ` (поле «${fieldName(task.field)}»)` : ""}`);
      continue;
    }
    if (was.text !== task.text) notes.push(`Попутная задача: текст ${quoteChange(was.text, task.text)}`);
    if ((was.when ?? "") !== (task.when ?? "")) notes.push(`Попутная задача «${task.text}»: условие ${quoteChange(was.when ?? "", task.when ?? "")}`);
    if (was.field !== task.field) notes.push(`Попутная задача «${task.text}»: поле было «${fieldName(was.field)}» → стало «${fieldName(task.field)}»`);
  }
  return notes;
}

/** Сценарий: «было → стало» по id нод, выходов и задач — переименование ноды не выглядит удалением. */
function describeFlow(before: AgentFlow, after: AgentFlow, fieldNames: ReadonlyMap<string, string>): string[] {
  const notes: string[] = [];
  const titles = new Map([...before.states, ...after.states].map((state) => [state.id, state.title]));
  const title = (id: string | null) => (id === null ? "никуда" : `«${titles.get(id) ?? id}»`);
  const old = new Map(before.states.map((state) => [state.id, state]));
  const now = new Map(after.states.map((state) => [state.id, state]));
  for (const state of before.states) if (!now.has(state.id)) notes.push(`Сценарий: удалена нода «${state.title}»`);
  for (const state of after.states) {
    const was = old.get(state.id);
    if (was) notes.push(...describeState(was, state, title));
    else notes.push(`Сценарий: добавлена нода «${state.title}»`);
  }
  if (before.start !== after.start) notes.push(`Сценарий: стартовая нода было ${title(before.start)} → стало ${title(after.start)}`);
  notes.push(...describeExits("Из любой ноды", before.anyState.exits, after.anyState.exits, title));
  if (nudgesText(before.nudges) !== nudgesText(after.nudges))
    notes.push(`Касания сценария: было «${nudgesText(before.nudges)}» → стало «${nudgesText(after.nudges)}»`);
  notes.push(...describeSchedule(before.schedule, after.schedule));
  notes.push(...describeSideTasks(before.sideTasks, after.sideTasks, fieldNames));
  const field = (id: string) => {
    const name = fieldNames.get(id);
    return name ? `поле «${name}»` : "удалённое поле";
  };
  const wasCard = before.clientCard.map((one) => one.id);
  const nowCard = after.clientCard.map((one) => one.id);
  for (const id of nowCard) if (!wasCard.includes(id)) notes.push(`Поля: подключено ${field(id)}`);
  for (const id of wasCard) if (!nowCard.includes(id)) notes.push(`Поля: отключено ${field(id)}`);
  return notes;
}

/**
 * Заметки «что эксперт поменял руками» — для конструктора, чтобы он не спорил с правкой.
 * `fieldNames` и `videoTitles` — имена полей и названия роликов по id: конструктору нужны имена, а не служебные номера.
 */
export function describeManualEdits(
  before: LeadMagnetSettings,
  after: LeadMagnetSettings,
  fieldNames: ReadonlyMap<string, string>,
  videoTitles: ReadonlyMap<string, string> = new Map(),
  imageTitles: ReadonlyMap<string, string> = new Map(),
): string[] {
  const notes: string[] = [];
  for (const [field, label] of Object.entries(textLabels) as Array<[keyof typeof textLabels, string]>)
    if (before[field] !== after[field]) notes.push(`${label}: ${quoteChange(before[field], after[field])}`);
  // Основная инструкция — «Общее» сценария
  if (before.flow.common !== after.flow.common) notes.push(`Основная инструкция: ${quoteChange(before.flow.common, after.flow.common)}`);
  if (before.maxPersonMessages !== after.maxPersonMessages)
    notes.push(`Предел сообщений человека: было «${before.maxPersonMessages}» → стало «${after.maxPersonMessages}»`);
  const model = (s: LeadMagnetSettings) => `${s.providerId} / ${s.modelId}${s.reasoning ? `, рассуждение ${s.reasoning}` : ""}`;
  if (model(before) !== model(after)) notes.push(`Модель: было «${model(before)}» → стало «${model(after)}»`);
  notes.push(...describeFlow(before.flow, after.flow, fieldNames));
  // Ролик без названия удалён из архива: из списка его убрало приложение, а не эксперт — заметка не нужна
  const video = (ids: string[], others: string[], verb: string) =>
    ids.flatMap((id) => (others.includes(id) || !videoTitles.has(id) ? [] : [`Видео: ${verb} ролик «${videoTitles.get(id)}»`]));
  notes.push(...video(after.videoIds, before.videoIds, "включён"), ...video(before.videoIds, after.videoIds, "выключен"));
  const image = (ids: string[], others: string[], verb: string) =>
    ids.flatMap((id) => (others.includes(id) || !imageTitles.has(id) ? [] : [`Картинки: ${verb} картинка «${imageTitles.get(id)}»`]));
  notes.push(...image(after.imageIds, before.imageIds, "включена"), ...image(before.imageIds, after.imageIds, "выключена"));
  return notes;
}

/** Хвост сообщения эксперта конструктору. Нет заметок — нет хвоста. */
export function constructorTail(notes: readonly string[]): string | null {
  if (notes.length === 0) return null;
  return ["Эксперт вручную изменил:", ...notes.map((note) => `— ${note}`)].join("\n");
}

/**
 * Заметки, которые влезают в хвост длиной `maxLength`: самые свежие важнее, порядок — от старых к новым.
 * Не влезшие остаются в очереди до следующего хода.
 */
export function fitManualEditNotes<T extends { text: string }>(notes: readonly T[], maxLength: number): T[] {
  const fitted: T[] = [];
  for (let index = notes.length - 1; index >= 0; index--) {
    const candidate = [notes[index]!, ...fitted];
    if ((constructorTail(candidate.map((note) => note.text)) ?? "").length > maxLength) break;
    fitted.unshift(notes[index]!);
  }
  return fitted;
}

/**
 * Черновик без полей, удалённых из словаря «Базы»: их нет в карточке, в полях лидмагнита и у попутных задач (задача
 * остаётся, без поля ответа). Только удалённые: id, которого в словаре не было никогда, остаётся и не пройдёт проверку.
 * Опубликованные версии не меняются — правится лишь новый черновик.
 */
export async function withoutDeletedFields(tx: DatabaseExecutor, settings: LeadMagnetSettings): Promise<LeadMagnetSettings> {
  const { flow, program } = settings;
  const referenced = [
    ...flow.clientCard.map((field) => field.id),
    ...(flow.sideTasks ?? []).flatMap((task) => (task.field === undefined ? [] : [task.field])),
    ...settings.fieldIds,
    ...(program?.sideTasks ?? []).flatMap((task) => (task.fieldId === null ? [] : [task.fieldId])),
  ];
  const deleted = new Set(await deletedFieldIds(tx, referenced));
  if (deleted.size === 0) return settings;
  // Заметка чата с тем же id — не поле «Базы»
  const notes = new Set(flow.chatNotes.map((note) => note.id));
  const sideTasks = flow.sideTasks?.map((task) => {
    if (task.field === undefined || !deleted.has(task.field) || notes.has(task.field)) return task;
    const { field: _deleted, ...rest } = task;
    return rest;
  });
  return {
    ...settings,
    fieldIds: settings.fieldIds.filter((id) => !deleted.has(id)),
    ...(program && {
      program: { ...program, sideTasks: program.sideTasks.map((task) => (task.fieldId && deleted.has(task.fieldId) ? { ...task, fieldId: null } : task)) },
    }),
    flow: {
      ...flow,
      clientCard: flow.clientCard.filter((field) => !deleted.has(field.id)),
      ...(sideTasks && { sideTasks }),
    },
  };
}

/** Итог ручной правки. `overwroteNewerDraft` — пока эксперт правил, черновик успел измениться, и правка легла поверх. */
export type ExpertEditResult = { version: LeadMagnetVersion; overwroteNewerDraft: boolean };

const OVERWRITE_NOTE =
  "Эксперт сохранил свою правку поверх более нового черновика: изменения, сделанные после того, как он открыл форму, заменены. Ниже — что стало иначе по сравнению с тем черновиком.";
const FLOW_OVERWRITE_NOTE =
  "Эксперт сохранил сценарий с доски поверх более нового черновика: сценарий заменён его версией, остальные настройки остались как в том черновике. Ниже — что стало иначе по сравнению с ним.";

/**
 * Ручная правка из настроек: новая версия «manual» и заметки для конструктора.
 * Последняя правка побеждает: устаревшая форма тоже сохраняется, а конструктор узнаёт об этом из заметки.
 */
export async function saveExpertEdit(
  db: Database,
  leadMagnetId: string,
  edit: { settings: LeadMagnetSettings; expectedVersionId: string },
): Promise<ExpertEditResult> {
  validateLeadMagnetSettings(edit.settings);
  return db.transaction(async (tx) => {
    const lead = await lockLeadMagnet(tx, leadMagnetId);
    const overwroteNewerDraft = lead.draftVersionId !== edit.expectedVersionId;
    const version = await saveEditBesideConstructor(tx, lead, edit.settings, "manual", overwroteNewerDraft ? [OVERWRITE_NOTE] : []);
    return { version, overwroteNewerDraft };
  });
}

/**
 * Сценарий с доски: ложится в черновик, прочитанный под той же блокировкой, — остальные настройки не трогаются, даже если
 * конструктор или «Настройки» обновили их, пока доска была открыта. Инструкция, поля и просмотр ссылок — по сценарию.
 */
export async function saveExpertFlowEdit(
  db: Database,
  leadMagnetId: string,
  edit: { flow: AgentFlow; expectedVersionId: string },
): Promise<ExpertEditResult> {
  return db.transaction(async (tx) => {
    const lead = await lockLeadMagnet(tx, leadMagnetId);
    const overwroteNewerDraft = lead.draftVersionId !== edit.expectedVersionId;
    const settings = withLeadMagnetFlow(lead.draft, edit.flow);
    const version = await saveEditBesideConstructor(tx, lead, settings, "manual", overwroteNewerDraft ? [FLOW_OVERWRITE_NOTE] : []);
    return { version, overwroteNewerDraft };
  });
}

/**
 * Описание карточки с главной страницы: ложится в черновик, прочитанный под блокировкой, остальные настройки не трогаются.
 * То же описание — без новой версии.
 */
export async function saveExpertCardDescription(db: Database, leadMagnetId: string, cardDescription: string): Promise<LeadMagnetVersion> {
  return db.transaction(async (tx) => {
    const lead = await lockLeadMagnet(tx, leadMagnetId);
    const text = cardDescription.trim();
    if (lead.draft.cardDescription === text) return (await getVersion(tx, lead.draftVersionId))!;
    return saveEditBesideConstructor(tx, lead, { ...lead.draft, cardDescription: text }, "manual");
  });
}

/**
 * Правка черновика не конструктором (эксперт руками, агент консольной командой): новая версия и заметки
 * «что изменилось» для конструктора. Строка лидмагнита уже заблокирована в этой транзакции.
 */
export async function saveEditBesideConstructor(
  tx: DatabaseExecutor,
  lead: LeadMagnet,
  settings: LeadMagnetSettings,
  source: Extract<VersionSource, "manual" | "agent">,
  leadingNotes: string[] = [],
): Promise<LeadMagnetVersion> {
  // Поля, удалённые из словаря, ролики и картинки, удалённые из архива, в черновике не остаются
  const checked = validateLeadMagnetSettings(await withoutDeletedFields(tx, validateLeadMagnetSettings(settings)));
  const videos = await getVideos(tx, [...new Set([...lead.draft.videoIds, ...checked.videoIds])]);
  const images = await getImages(tx, [...new Set([...lead.draft.imageIds, ...checked.imageIds])]);
  const valid = {
    ...checked,
    videoIds: checked.videoIds.filter((id) => videos.some((video) => video.id === id)),
    imageIds: checked.imageIds.filter((id) => images.some((image) => image.id === id)),
  };
  const version = await saveDraft(tx, lead.id, valid, source);
  const fields = await getFields(tx, [...new Set([...lead.draft.flow.clientCard, ...valid.flow.clientCard].map((field) => field.id))]);
  const notes = describeManualEdits(
    lead.draft,
    valid,
    new Map(fields.map((one) => [one.id, one.name])),
    new Map(videos.map((one) => [one.id, one.title])),
    new Map(images.map((one) => [one.id, one.title])),
  );
  await appendManualEditNotes(tx, lead.id, [...leadingNotes, ...notes]);
  return version;
}

const versionTime = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "medium", timeZone: AGENT_TIME_ZONE });

/** Откат из «Истории»: черновик — как в выбранной версии; конструктору короткая заметка без полного «было → стало». Последний побеждает. */
export async function rollbackByExpert(
  db: Database,
  leadMagnetId: string,
  input: { versionId: string; expectedVersionId: string },
): Promise<ExpertEditResult> {
  return db.transaction(async (tx) => {
    const lead = await lockLeadMagnet(tx, leadMagnetId);
    const overwroteNewerDraft = lead.draftVersionId !== input.expectedVersionId;
    const target = await getVersion(tx, input.versionId);
    if (!target || target.leadMagnetId !== leadMagnetId) throw new Error(`У лидмагнита ${leadMagnetId} нет версии ${input.versionId}`);
    const version = await saveDraft(tx, leadMagnetId, target.settings, "rollback");
    const note = `Эксперт вернул черновик к версии от ${versionTime.format(target.createdAt)}`;
    await appendManualEditNotes(tx, leadMagnetId, [overwroteNewerDraft ? `${note} — поверх более нового черновика, который успел измениться` : note]);
    return { version, overwroteNewerDraft };
  });
}
