import type { AgentFlow, FlowDuration, FlowNudges } from "@ykurilov/agent-chat-flows/format";
import { NEW_CONVERSATION_NUDGES } from "./settings-to-flow";

/**
 * Сроки молчания человека у лидмагнита без программы, в днях. «Напоминать» — сколько дней тишины агент ещё пишет первым
 * (`nudges.stopAfter`); «Ждать ответа» — через сколько дней тишины разговор считается «не завершил» (`nudges.giveUpAfter`),
 * `null` — без срока.
 */
export interface SilenceSettings {
  remindDays: number;
  waitDays: number | null;
}

const UNIT_DAYS = { min: 1 / 1440, h: 1 / 24, d: 1 } as const;
const DEFAULT_REMIND_DAYS = 3;

export const REMIND_LONGER_THAN_WAIT = "«Напоминать» не может быть дольше «Ждать ответа»";
const PROGRAM_HAS_NO_SILENCE = "У воронки на несколько дней сроков «Напоминать» и «Ждать ответа» нет: разговор кончается сроком воронки";

const daysOf = (duration: FlowDuration) => duration.amount * UNIT_DAYS[duration.unit];
const durationOfDays = (days: number): FlowDuration => (Number.isInteger(days) ? { amount: days, unit: "d" } : { amount: Math.round(days * 24), unit: "h" });

/** Сроки молчания сценария. У прежних сценариев без «Напоминать» касания идут до «не завершил». Воронка — `null`. */
export function silenceOf(flow: Pick<AgentFlow, "nudges" | "schedule">): SilenceSettings | null {
  if (flow.schedule) return null;
  const { stopAfter, giveUpAfter } = flow.nudges ?? {};
  const remind = stopAfter ?? giveUpAfter;
  return { remindDays: remind ? daysOf(remind) : DEFAULT_REMIND_DAYS, waitDays: giveUpAfter ? daysOf(giveUpAfter) : null };
}

/**
 * Касания с новыми сроками молчания, без проверок — для формы, где эксперт ещё набирает число: прежние касания те же
 * (нет своих — касания нового лидмагнита).
 */
export function nudgesWithSilence(nudges: AgentFlow["nudges"], silence: SilenceSettings): FlowNudges {
  const { stopAfter: _stop, giveUpAfter: _giveUp, ...touches } = nudges ?? NEW_CONVERSATION_NUDGES;
  return {
    ...touches,
    stopAfter: durationOfDays(silence.remindDays),
    ...(silence.waitDays !== null && { giveUpAfter: durationOfDays(silence.waitDays) }),
  };
}

/** Сценарий с новыми сроками молчания. Воронка или «Напоминать» дольше «Ждать ответа» — ошибка словами. */
export function withSilence<Flow extends Pick<AgentFlow, "nudges" | "schedule">>(flow: Flow, silence: SilenceSettings): Flow {
  if (flow.schedule) throw new Error(PROGRAM_HAS_NO_SILENCE);
  if (remindLongerThanWait(silence)) throw new Error(REMIND_LONGER_THAN_WAIT);
  return { ...flow, nudges: nudgesWithSilence(flow.nudges, silence) };
}

export const remindLongerThanWait = (silence: SilenceSettings) => silence.waitDays !== null && silence.remindDays > silence.waitDays;
