// Готовый результат сценария для тестов проверок и отчёта.
import { leadMagnetToFlow } from "@/modules/flows";
import { newLeadMagnetSettings, newProgramSettings, type LeadMagnetSettings } from "@/modules/lead-magnets/settings";
import type { AppModels } from "@/modules/platform/app-models";
import type { PersonaRoute } from "./persona-model";
import type { BotMessageKind, ClientRun, ConsultantTurn, EventMoment, FlowTransitionRecord, ScenarioRun } from "./types";

export const POLICY_URL = "https://eval.local/privacy";

export function consultantTurn(overrides: Partial<ConsultantTurn> = {}): ConsultantTurn {
  return { client: "Привет", bot: ["Здравствуйте! Чем занимаетесь?"], consultantMessages: 1, tools: [], finished: false, textAfterFinish: null, durationMs: 1200, ...overrides };
}

export function clientRun(overrides: Partial<ClientRun> = {}): ClientRun {
  return {
    index: 1,
    name: "Сомневающаяся Марина",
    turns: [
      consultantTurn({ client: "/start code", bot: [`Привет! Чем занимаетесь?\n\nПродолжая разговор, вы соглашаетесь с политикой обработки персональных данных: ${POLICY_URL}`] }),
      consultantTurn({ client: "Йогой", bot: ["Итог: хотите пробное занятие. Подходит?"] }),
      consultantTurn({
        client: "Да, подходит",
        bot: ["Спасибо за разговор!"],
        tools: [{ name: "finish_dialog", input: { goal: "Г", stuckAt: "З", chosenStep: "Ш", outcome: "agreed" }, output: { ok: true } }],
        finished: true,
        textAfterFinish: null,
      }),
    ],
    clientReplies: 2,
    endedBy: "consultant_finished",
    passage: { status: "completed", summary: { goal: "Г", stuckAt: "З", chosenStep: "Ш", outcome: "agreed" }, personMessageCount: 3, handoverReason: null },
    chat: [],
    ...overrides,
  };
}

export function scenarioRun(overrides: Partial<ScenarioRun> = {}): ScenarioRun {
  return {
    scenario: {
      id: "normal-yoga",
      kind: "normal",
      title: "Йога для офиса",
      expertReplies: 12,
      clientReplies: 10,
      expert: { card: "Анна", goal: "Лидмагнит" },
      clients: [
        { name: "Сомневающаяся Марина", card: "Марина" },
        { name: "Односложный Олег", card: "Олег" },
      ],
    },
    startedAt: "2026-10-05T10:00:00.000Z",
    durationMs: 90_000,
    building: {
      turns: [{ expert: "Хочу лидмагнит", reply: "Записал первое сообщение.", tools: [{ name: "edit_lead_magnet", input: {}, output: { ok: true } }], status: "complete", durationMs: 3000 }],
      expertReplies: 1,
      endedBy: "expert_finished",
      chat: [],
    },
    settings: {
      ...newLeadMagnetSettings("Йога", "Пробное занятие по йоге"),
      instruction: "Ты консультант по йоге.",
      firstMessage: "Привет! Чем занимаетесь?",
      endCondition: "Человек выбрал пробное занятие",
      farewellMessage: "Спасибо за разговор!",
    },
    publishError: null,
    privacyPolicyUrl: POLICY_URL,
    clients: [clientRun(), clientRun({ index: 2, name: "Односложный Олег" })],
    agentLogErrors: [],
    runnerErrors: [],
    usage: {
      agents: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 300, reasoningTokens: 50, costUsd: 0.01 },
      personas: { inputTokens: 500, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 0, costUsd: 0.002 },
    },
    ...overrides,
  };
}

/** Момент дня программы: 12 октября — день 1. */
export const moment = (day: number, time: string): EventMoment => ({ at: `2026-10-${10 + day}T${time}:00+03:00`, day, localTime: time, localDate: `2026-10-${10 + day}` });

/** Момент разговора без «Дней и времени»: день 1 — 12 октября. */
export const plainMoment = (day: number, time: string): EventMoment => ({ at: `2026-10-${10 + day}T${time}:00+03:00`, localTime: time, localDate: `2026-10-${10 + day}` });

/** Сообщение бота: вид, день, время, текст. */
export type BotLine = [kind: BotMessageKind, day: number, time: string, text: string];

function withTimeline(turn: Partial<ConsultantTurn>, replies: BotLine[], at: (day: number, time: string) => EventMoment = moment): ConsultantTurn {
  return consultantTurn({
    ...turn,
    bot: replies.map(([, , , text]) => text),
    timeline: replies.map(([kind, day, time, text]) => ({ ...at(day, time), kind, text })),
    consultantMessages: replies.filter(([kind]) => kind === "consultant" || kind === "day_closed").length,
  });
}

/** Клиент написал в день и время; по умолчанию консультант сразу ответил. */
export function said(text: string, day: number, time: string, replies: BotLine[] = [["consultant", day, time, "Понятно, давайте дальше."]]): ConsultantTurn {
  return withTimeline({ client: text, sentAt: moment(day, time) }, replies);
}

/** Клиент молчал до этого дня и времени; бот за это время прислал `replies`. */
export function silent(silence: string, day: number, time: string, replies: BotLine[] = []): ConsultantTurn {
  return withTimeline({ client: "", silence, sentAt: moment(day, time) }, replies);
}

/** Молчание клиента в разговоре без «Дней и времени»: дни — календарные. */
export function plainSilent(silence: string, day: number, time: string, replies: BotLine[] = []): ConsultantTurn {
  return withTimeline({ client: "", silence, sentAt: plainMoment(day, time) }, replies, plainMoment);
}

/**
 * Лидмагнит на 3 дня, как его переводит `leadMagnetToFlow`: ноды «Идея» и «Продажа» (метка «продажа», событие дня 3
 * программы ведёт в неё), рамки дня 2 и 3 сообщения, ночь с 21:00 до 9:00, не больше 3 сообщений первым.
 * Старых этапов и программы в настройках нет: проверки читают только сценарий.
 */
export function programSettings(): LeadMagnetSettings {
  const base = {
    ...newLeadMagnetSettings("Первое приложение", "Программа на три дня"),
    instruction: "Ты помощник.",
    firstMessage: "Привет! Что соберём?",
    endCondition: "Человек сказал «да» интенсиву",
    farewellMessage: "До встречи на интенсиве!",
  };
  const flow = leadMagnetToFlow(
    {
      ...base,
      stages: [
        { id: "idea", name: "Идея", instruction: "Помоги выбрать", transitionCondition: "Идея выбрана", startDay: null, isSale: false },
        { id: "sale", name: "Продажа", instruction: "Предложи интенсив", transitionCondition: "", startDay: 3, isSale: true },
      ],
      program: { ...newProgramSettings(3), softDailyMessages: 2, hardDailyMessages: 3 },
    },
    [],
  );
  return { ...base, flow };
}

/** Шаг пути по сценарию программы: по умолчанию событие дня 3 ведёт в «Продажу». */
export function transition(overrides: Partial<FlowTransitionRecord> = {}): FlowTransitionRecord {
  return { to: "sale", title: "Продажа", from: "idea", decidedBy: "timer", reason: "наступил день 3", day: 3, at: moment(3, "09:00").at, tags: ["продажа"], ...overrides };
}

/** Начало сценария — первый шаг пути. */
export const flowStart = (day = 1): FlowTransitionRecord => ({ to: "idea", title: "Идея", from: null, decidedBy: "start", reason: null, day, at: moment(day, "12:00").at, tags: [] });

/** Клиент программы: срок вышел, finish_dialog не было. */
export function programClient(turns: ConsultantTurn[], overrides: Partial<ClientRun> = {}): ClientRun {
  return clientRun({
    turns: [said("/start code", 1, "12:00", [["other", 1, "12:00", `Привет! Что соберём?\n\nПолитика: ${POLICY_URL}`]]), ...turns],
    clientReplies: turns.filter((turn) => !turn.silence).length,
    endedBy: "program_ended",
    passage: { status: "term_ended", summary: null, personMessageCount: turns.length, handoverReason: null },
    flow: { transitions: [flowStart(), transition()], endReason: "deadline" },
    ...overrides,
  });
}

export function programRun(clients: ClientRun[]): ScenarioRun {
  return scenarioRun({ settings: programSettings(), clients });
}

/** Персонажи на той же подставной модели, что агенты: маршрута OpenRouter в тестах нет. */
export function stubPersonaRoute(models: AppModels): PersonaRoute {
  return {
    catalog: models.catalog,
    choice: models.constructorChoice,
    env: models.env,
    report: async () => ({ model: "stub", provider: "stub", temperature: 0, requests: 0, served: {}, offRoute: 0, failed: 0 }),
  };
}
