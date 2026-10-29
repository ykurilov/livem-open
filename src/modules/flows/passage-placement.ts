// Место идущего прохождения в сценарии SDK (plan.md, раздел 3.3): нода, начало, последние реплики, шаг касаний и счёт
// сегодняшнего дня — из колонок прохождения, которые вела старая версия. Его берут перенос идущих чатов (`flow.adopt`)
// и `loadFlow`, если человек напишет раньше переноса.
import type { FlowTodayCounts } from "@ykurilov/agent-chat-flows";
import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { and, eq, gte, inArray, max, count } from "drizzle-orm";
import { outboundMessages } from "../channels/schema";
import type { passages } from "../conversations/schema";
import { people } from "../people/schema";
import type { DatabaseExecutor } from "../platform/db";
import { atLocalTime, isValidTimeZone, localDate, programDay } from "../program/calendar";

export type PassageFacts = Pick<
  typeof passages.$inferSelect,
  | "startedAt"
  | "currentStageId"
  | "stageHistory"
  | "lastPersonMessageAt"
  | "reminderChainStartedAt"
  | "reminderStep"
  | "programStartDate"
  | "dayMessageCount"
  | "dayMessageCountDay"
  | "personClosedDay"
>;

/** Поля переноса `flow.adopt` / `loadFlow`. Нет `stateId` — старт сценария, нет `enteredAt` — `startedAt`. */
export interface PassagePlacement {
  stateId?: string;
  startedAt: Date;
  enteredAt?: Date;
  lastHumanAt?: Date;
  lastAgentAt: Date;
  nudgeStep: number;
  today: FlowTodayCounts;
  timeZone?: string;
}

export interface PassagePlacementInput {
  passage: PassageFacts;
  flow: AgentFlow;
  /** Пояс человека (`people.time_zone`); неизвестен — Москва, как считала старая программа. */
  timeZone: string | null;
  /** Последнее сообщение первым, ушедшее человеку: напоминание или сообщение программы. */
  lastFirstMessageAt: Date | null;
  /** Сколько сообщений первым ушло человеку сегодня по его часам: потолок дня. */
  firstMessagesToday: number;
  now: Date;
}

const later = (a: Date, b: Date | null) => (b && b > a ? b : a);

export function passagePlacement(input: PassagePlacementInput): { placement: PassagePlacement; warnings: string[] } {
  const { passage, flow, now } = input;
  const warnings: string[] = [];
  const timeZone = input.timeZone && isValidTimeZone(input.timeZone) ? input.timeZone : null;
  const program = flow.schedule?.lengthDays !== undefined && passage.programStartDate !== null ? passage.programStartDate : null;
  // День программы у SDK начинается в `dayStart`: так номер дня совпадёт со старым и поздний старт его не сдвинет
  const startedAt = program ? atLocalTime(program, flow.schedule!.dayStart, timeZone) : passage.startedAt;

  let stateId: string | undefined;
  let enteredAt: Date | undefined;
  const stageId = passage.currentStageId;
  if (stageId !== null && flow.states.some((state) => state.id === stageId)) {
    stateId = stageId;
    const entry = passage.stageHistory.findLast((item) => item.stageId === stageId);
    if (entry) enteredAt = later(startedAt, new Date(entry.at));
  } else if (stageId !== null) {
    warnings.push(`этапа «${stageId}» нет в сценарии снимка — чат пойдёт с начала сценария`);
  }

  const today: FlowTodayCounts = {};
  if (input.firstMessagesToday > 0) today.firstMessages = input.firstMessagesToday;
  if (program) {
    const day = programDay({ startDate: program, now, timeZone });
    today.humanMessages = passage.dayMessageCountDay === day ? passage.dayMessageCount : 0;
    today.dayClosed = passage.personClosedDay === day;
  }

  return {
    placement: {
      ...(stateId && { stateId }),
      startedAt,
      ...(enteredAt && { enteredAt }),
      ...(passage.lastPersonMessageAt && { lastHumanAt: passage.lastPersonMessageAt }),
      // Первое сообщение лидмагнита уходит в начале прохождения: до ответа консультанта тишина считается от него
      lastAgentAt: later(passage.reminderChainStartedAt ?? passage.startedAt, input.lastFirstMessageAt),
      nudgeStep: passage.reminderStep,
      today,
      ...(timeZone && { timeZone }),
    },
    warnings,
  };
}

/** Сообщения первым старой и новой версии: напоминания бросившим и сообщения программы. */
const FIRST_MESSAGE_KINDS = ["reminder", "outreach"] as const;

/** Место прохождения по базе: пояс человека и сообщения первым — из «Базы» и исходящих. */
export async function readPassagePlacement(
  db: DatabaseExecutor,
  passage: PassageFacts & Pick<typeof passages.$inferSelect, "id" | "personId">,
  flow: AgentFlow,
  now: Date,
): Promise<{ placement: PassagePlacement; warnings: string[] }> {
  const [person] = await db.select({ timeZone: people.timeZone }).from(people).where(eq(people.id, passage.personId));
  const timeZone = person?.timeZone ?? null;
  const sent = and(
    eq(outboundMessages.personId, passage.personId),
    inArray(outboundMessages.kind, [...FIRST_MESSAGE_KINDS]),
    eq(outboundMessages.status, "sent"),
  );
  const [last] = await db
    .select({ at: max(outboundMessages.sentAt) })
    .from(outboundMessages)
    .where(and(sent, eq(outboundMessages.passageId, passage.id)));
  // Потолок дня у SDK — на человека, по его часам: считаются все сообщения первым с полуночи
  const midnight = atLocalTime(localDate(now, timeZone), "00:00", timeZone);
  const [today] = await db
    .select({ sent: count() })
    .from(outboundMessages)
    .where(and(sent, gte(outboundMessages.sentAt, midnight)));
  return passagePlacement({ passage, flow, timeZone, lastFirstMessageAt: last?.at ?? null, firstMessagesToday: today?.sent ?? 0, now });
}
