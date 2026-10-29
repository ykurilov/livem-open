import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { z } from "zod";
import { leadMagnetToFlow } from "../flows/settings-to-flow";
import { validateLeadMagnetFlow, type FlowSettingsIssue } from "../flows/validate-flow";
import { DEFAULT_MODEL_CHOICE } from "../platform/models-catalog";
import { productLinkSchema } from "../purchases/product-links";
import { textLinkSchema } from "../text-links/text-link";

export const DEFAULT_MAX_PERSON_MESSAGES = 60;
export const STAGE_INSTRUCTION_MAX_LENGTH = 1500;

export const PROGRAM_MIN_DAYS = 2;
export const PROGRAM_MAX_DAYS = 14;
/** Утро программы не раньше 5:00: в 5:00 начинается новый день. */
export const PROGRAM_DAY_STARTS_AT = "05:00";
export const SIDE_TASK_TEXT_MAX_LENGTH = 300;
export const SIDE_TASKS_MAX_COUNT = 10;

export const stageSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, "У этапа должно быть название"),
  instruction: z
    .string()
    .max(STAGE_INSTRUCTION_MAX_LENGTH, `Инструкция этапа — не длиннее ${STAGE_INSTRUCTION_MAX_LENGTH} знаков`),
  transitionCondition: z.string(),
  /** День программы, в который этап включается сам. `null` — только по условию перехода. */
  startDay: z.number().int("День начала этапа — целое число").min(1, "День начала этапа — не меньше 1").nullable().default(null),
  /** Этап «Продажа»: к нему приложение добавляет правила продажи. Не больше одного на лидмагнит. */
  isSale: z.boolean().default(false),
});

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Время пишется в виде ЧЧ:ММ, например 10:00");

/** Расписание сообщений, которые бот пишет первым, когда человек молчит. */
export const outreachSettingsSchema = z
  .object({
    /** Утреннее сообщение со дня 2, по времени человека. */
    morningAt: timeOfDay,
    /** Со дня 2: через сколько часов тишины каждое следующее сообщение после утреннего или ответа человека. */
    afterSilenceHours: z.array(z.number().positive("Часы тишины — положительные числа")).max(10),
    /** День 1: через сколько минут от начала тишины уходит каждое сообщение (по возрастанию). */
    firstDayAfterSilenceMinutes: z.array(z.number().positive("Минуты тишины — положительные числа")).max(10),
    maxPerDay: z.number().int("Потолок сообщений первым в день — целое число").min(1, "Потолок сообщений первым в день — хотя бы 1").max(10),
    latestAt: timeOfDay,
  })
  .superRefine((outreach, ctx) => {
    const minutes = outreach.firstDayAfterSilenceMinutes;
    if (minutes.some((value, index) => index > 0 && value <= minutes[index - 1]!))
      ctx.addIssue({ code: "custom", message: "Минуты тишины в день 1 идут по возрастанию" });
    if (outreach.morningAt < PROGRAM_DAY_STARTS_AT)
      ctx.addIssue({ code: "custom", message: "Утреннее сообщение — не раньше 5:00: в 5:00 начинается новый день" });
    else if (outreach.morningAt >= outreach.latestAt)
      ctx.addIssue({ code: "custom", message: "Утреннее сообщение должно быть раньше последнего времени для сообщений первым" });
  });

/** Попутная задача: консультант решает её к слову, ниже главной цели. */
export const sideTaskSchema = z.object({
  id: z.string().min(1),
  task: z.string().trim().min(1, "У попутной задачи должен быть текст").max(SIDE_TASK_TEXT_MAX_LENGTH, `Текст попутной задачи — не длиннее ${SIDE_TASK_TEXT_MAX_LENGTH} знаков`),
  /** Поле базы, куда пишется ответ; `null` — задача без поля. */
  fieldId: z.string().uuid().nullable(),
  /** Когда задача уместна, словами. Пусто — когда угодно. */
  when: z.string().max(SIDE_TASK_TEXT_MAX_LENGTH, `Условие попутной задачи — не длиннее ${SIDE_TASK_TEXT_MAX_LENGTH} знаков`),
});

/** Программа на несколько дней: срок, рамки дня, сообщения первым, попутные задачи. */
export const programSettingsSchema = z.object({
  days: z.number().int(`Срок воронки — целое число дней`).min(PROGRAM_MIN_DAYS, `Срок воронки — от ${PROGRAM_MIN_DAYS} до ${PROGRAM_MAX_DAYS} дней`).max(PROGRAM_MAX_DAYS, `Срок воронки — от ${PROGRAM_MIN_DAYS} до ${PROGRAM_MAX_DAYS} дней`),
  /** С этого числа сообщений человека за день консультант начинает по-доброму прощаться до завтра. */
  softDailyMessages: z.number().int().min(1, "Мягкая рамка дня — хотя бы 1 сообщение"),
  /** На этом сообщении — последнее прощание «продолжим утром»; дальше консультант до утра не вызывается. */
  hardDailyMessages: z.number().int().min(1, "Жёсткая рамка дня — хотя бы 1 сообщение"),
  outreach: outreachSettingsSchema,
  sideTasks: z.array(sideTaskSchema).max(SIDE_TASKS_MAX_COUNT, `Попутных задач — не больше ${SIDE_TASKS_MAX_COUNT}`),
});

/** Текст, который человек получает как есть: подстановку «{имя}» никто не заполнит. */
function sentAsIs(where: string) {
  return z.string().superRefine((text, ctx) => {
    const placeholder = text.match(/\{[^{}]*\}/)?.[0];
    if (placeholder)
      ctx.addIssue({
        code: "custom",
        message: `В ${where} есть «${placeholder}». Подстановки не заполняются: человек увидит её как есть. Напишите текст без фигурных скобок`,
      });
  });
}

/** Все настройки консультанта. Черновик, версия и снимок хранят их целиком. */
export const leadMagnetSettingsSchema = z.object({
  name: z.string().trim().min(1, "У лидмагнита должно быть название"),
  cardDescription: z.string(),
  instruction: z.string(),
  firstMessage: sentAsIs("первом сообщении"),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  /** Уровень рассуждения; `null` — уровень по умолчанию модели. */
  reasoning: z.string().nullable(),
  stages: z.array(stageSchema),
  endCondition: z.string(),
  farewellMessage: sentAsIs("прощальном сообщении"),
  maxPersonMessages: z.number().int().min(1, "Предел сообщений — хотя бы 1").max(1000),
  fieldIds: z.array(z.string().uuid()),
  /** Ролики архива, которые консультант может присылать. */
  videoIds: z.array(z.string().uuid()),
  /** Картинки архива (скриншоты «куда нажать»), которые консультант может показывать. Сохранённые до архива — без картинок. */
  imageIds: z.array(z.string().uuid()).default([]),
  /** Консультант смотрит снимок страницы по ссылке, которую прислал человек. */
  viewsLinks: z.boolean(),
  /** Программа на несколько дней; `null` — один разговор, как раньше. */
  program: programSettingsSchema.nullable().default(null),
  /**
   * Сценарий SDK (`agent-flow`): ноды, переходы, «Дни и время», касания, карточка клиента, попутные задачи. Заменяет
   * `stages`, `program`, `fieldIds`, `viewsLinks` и `instruction`; они пока читаются ради отката и не правятся.
   * Разбор и проверка — в `validateLeadMagnetSettings`.
   */
  flow: z.custom<AgentFlow>((value) => value !== undefined, { message: "У лидмагнита нет сценария (flow)" }),
  /**
   * Ссылки продуктов, оплату которых мы узнаём (GetCourse): к ним на выходе к человеку дописываются метки с его личным
   * кодом. Нет или пусто — ссылки уходят как есть, оплату Василий не отслеживает. У снимков до 21.10.2026 поля нет.
   */
  productLinks: z.array(productLinkSchema).max(10, "Ссылок продуктов — не больше 10").optional(),
  /** Ссылка с подставленным текстом (например, идея уже в поле): её собирает инструмент `text_link`. Нет — инструмента нет. */
  textLink: textLinkSchema.optional(),
});

export type Stage = z.infer<typeof stageSchema>;
export type OutreachSettings = z.infer<typeof outreachSettingsSchema>;
export type SideTask = z.infer<typeof sideTaskSchema>;
export type ProgramSettings = z.infer<typeof programSettingsSchema>;
export type LeadMagnetSettings = z.infer<typeof leadMagnetSettingsSchema>;

export const DEFAULT_SOFT_DAILY_MESSAGES = 20;
export const DEFAULT_HARD_DAILY_MESSAGES = 30;

export const DEFAULT_OUTREACH_SETTINGS: OutreachSettings = {
  morningAt: "10:00",
  afterSilenceHours: [3, 3],
  firstDayAfterSilenceMinutes: [15, 60, 240],
  maxPerDay: 3,
  latestAt: "21:00",
};

/** Программа с настройками по умолчанию из спецификации. */
export function newProgramSettings(days: number): ProgramSettings {
  return {
    days,
    softDailyMessages: DEFAULT_SOFT_DAILY_MESSAGES,
    hardDailyMessages: DEFAULT_HARD_DAILY_MESSAGES,
    outreach: {
      ...DEFAULT_OUTREACH_SETTINGS,
      afterSilenceHours: [...DEFAULT_OUTREACH_SETTINGS.afterSilenceHours],
      firstDayAfterSilenceMinutes: [...DEFAULT_OUTREACH_SETTINGS.firstDayAfterSilenceMinutes],
    },
    sideTasks: [],
  };
}

export function newLeadMagnetSettings(name: string, cardDescription = ""): LeadMagnetSettings {
  return {
    name,
    cardDescription,
    instruction: "",
    firstMessage: "",
    providerId: DEFAULT_MODEL_CHOICE.providerId,
    modelId: DEFAULT_MODEL_CHOICE.modelId,
    reasoning: null,
    stages: [],
    endCondition: "",
    farewellMessage: "",
    maxPersonMessages: DEFAULT_MAX_PERSON_MESSAGES,
    fieldIds: [],
    videoIds: [],
    imageIds: [],
    viewsLinks: false,
    program: null,
    flow: leadMagnetToFlow({ name, instruction: "", stages: [], program: null, fieldIds: [], viewsLinks: false }, []),
  };
}

export class InvalidLeadMagnetSettingsError extends Error {
  /** Ошибки сценария с путём от корня настроек (`flow.states[2].exits[0].when.text`); у ошибок старых полей пусто. */
  readonly issues: FlowSettingsIssue[];

  constructor(message: string, issues: FlowSettingsIssue[] = []) {
    super(message);
    this.name = "InvalidLeadMagnetSettingsError";
    this.issues = issues;
  }
}

/** Сценарий разобран со значениями по умолчанию и проверен SDK и нашими проверками; ошибка — с путями. */
function checkedFlow(input: unknown): AgentFlow {
  const result = validateLeadMagnetFlow(input);
  if (result.ok) return result.flow;
  const issues = result.issues.map((issue) => ({ path: issue.path ? `flow.${issue.path}` : "flow", message: issue.message }));
  throw new InvalidLeadMagnetSettingsError(issues.map((issue) => `«${issue.path}»: ${issue.message}`).join("; "), issues);
}

/** Правила между разными частями настроек: программа, этапы, поля. */
function checkProgram(settings: LeadMagnetSettings): void {
  const { program, stages } = settings;
  const stop = (message: string): never => {
    throw new InvalidLeadMagnetSettingsError(message);
  };

  if (program) {
    if (program.softDailyMessages >= program.hardDailyMessages)
      stop("Мягкая рамка дня должна быть меньше жёсткой");
    const taskIds = program.sideTasks.map((task) => task.id);
    if (new Set(taskIds).size !== taskIds.length) stop("У попутных задач повторяются id");
    for (const task of program.sideTasks)
      if (task.fieldId && !settings.fieldIds.includes(task.fieldId))
        stop(`Поле попутной задачи «${task.task}» не подключено к лидмагниту`);
  }

  let previousDay = 0;
  for (const stage of stages) {
    if (stage.startDay === null) continue;
    if (!program) stop(`У этапа «${stage.name}» задан день начала, а воронки на несколько дней нет`);
    if (program && stage.startDay > program.days)
      stop(`Этап «${stage.name}» включается в день ${stage.startDay}, а воронка идёт ${program.days} дн.`);
    if (stage.startDay < previousDay)
      stop(`Дни начала этапов не убывают: «${stage.name}» стоит позже этапа с днём ${previousDay}, а включается раньше`);
    previousDay = stage.startDay;
  }
  if (stages.filter((stage) => stage.isSale).length > 1) stop("Отметка «Продажа» может стоять не больше чем у одного этапа");
}

/** Проверяет настройки целиком; ошибка — понятным текстом (его видит и эксперт, и конструктор). */
export function validateLeadMagnetSettings(settings: unknown): LeadMagnetSettings {
  const parsed = leadMagnetSettingsSchema.safeParse(settings);
  if (parsed.success) {
    const ids = parsed.data.stages.map((stage) => stage.id);
    if (new Set(ids).size !== ids.length) throw new InvalidLeadMagnetSettingsError("У этапов повторяются id");
    const checked = { ...parsed.data, videoIds: [...new Set(parsed.data.videoIds)], imageIds: [...new Set(parsed.data.imageIds)], flow: checkedFlow(parsed.data.flow) };
    checkProgram(checked);
    return checked;
  }
  throw new InvalidLeadMagnetSettingsError(parsed.error.issues.map((issue) => issue.message).join("; "));
}
