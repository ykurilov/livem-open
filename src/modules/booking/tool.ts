import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { CallRefusal } from "./bookings";
import type { CallBookingSetting } from "./setting";
import { localStartOf, slotLabel, type CallInterval } from "./slots";

export const CALL_FREE_TIMES_TOOL = "call_free_times";
export const BOOK_CALL_TOOL = "book_call";
export const CHANGE_CALL_TOOL = "change_call";

/** Сколько ближайших созвонов видит агент за один вызов. */
const SLOTS_PER_CALL = 12;

type Chat = { ownerId: string; chatId: string };

/** Запись этого чата, как её видит агент. */
export interface CallBookingView extends CallInterval {
  meetingLink: string | null;
}

/** Что инструментам записи нужно от приложения: живой разговор и «Проверка» дают своё (участник, последствия записи). */
export interface CallBookingPort {
  freeTimes(chat: Chat): Promise<{ timeZone: string; callMinutes: number; slots: CallInterval[]; booking: CallBookingView | null }>;
  book(chat: Chat, start: string): Promise<{ ok: true; booking: CallBookingView; timeZone: string } | { ok: false; reason: CallRefusal; booking?: CallBookingView; timeZone: string }>;
  reschedule(chat: Chat, start: string): Promise<{ ok: true; booking: CallBookingView; timeZone: string } | { ok: false; reason: CallRefusal; timeZone: string }>;
  cancel(chat: Chat): Promise<{ ok: boolean }>;
}

const REFUSALS: Record<CallRefusal, string> = {
  not_free: `Это время уже занято или его нет в календаре эксперта. Возьми свежее свободное время (${CALL_FREE_TIMES_TOOL}).`,
  bad_time: `start — только значение start из ${CALL_FREE_TIMES_TOOL}.`,
  has_booking: `У человека уже есть запись. Сменить время — ${CHANGE_CALL_TOOL} с action "reschedule".`,
  no_booking: "У человека нет записи в будущем.",
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Инструменты записи на созвон. Описания неизменны для версии лидмагнита: меняются только вместе с настройкой эксперта.
 * Свободное время меняется каждую минуту — его агент берёт инструментом, в инструкцию оно не попадает (кэш модели).
 */
export function createCallBookingTools(setting: CallBookingSetting, port: CallBookingPort, chat: Chat): ToolSet {
  const about = setting.about.trim();
  const view = (booking: CallBookingView, timeZone: string) => ({
    start: localStartOf(booking.startsAt, timeZone),
    label: slotLabel(booking, timeZone),
    ...(booking.meetingLink && { meetingLink: booking.meetingLink }),
  });
  return {
    [CALL_FREE_TIMES_TOOL]: tool({
      description:
        "Свободное время эксперта для созвона с человеком и текущая запись человека, если она есть. Эксперт хочет, чтобы ты предлагал созвон, когда: " +
        setting.when.trim() +
        (about ? `\nЧто эксперт просит сказать о созвоне: ${about}` : "") +
        "\nВремя меняется: бери его этим инструментом каждый раз, когда предлагаешь, записываешь или переносишь, и не придумывай своё. " +
        "Предлагай человеку два-три ближайших подходящих варианта и называй время с поясом из подписи; если человек живёт в другом поясе, пересчитай и назови оба. " +
        "Нужен более поздний день — передай from.",
      inputSchema: z.object({
        from: z.string().regex(DATE).optional().describe("День ГГГГ-ММ-ДД по часам эксперта, с которого показать время. Нет — ближайшее."),
      }),
      execute: async ({ from }) => {
        const free = await port.freeTimes(chat);
        const slots = free.slots.filter((slot) => !from || localStartOf(slot.startsAt, free.timeZone).slice(0, 10) >= from).slice(0, SLOTS_PER_CALL);
        return {
          timeZone: free.timeZone,
          callMinutes: free.callMinutes,
          slots: slots.map((slot) => ({ start: localStartOf(slot.startsAt, free.timeZone), label: slotLabel(slot, free.timeZone) })),
          booking: free.booking && view(free.booking, free.timeZone),
          ...(slots.length === 0 && { note: "Свободного времени нет: созвон сейчас не предлагай." }),
        };
      },
    }),
    [BOOK_CALL_TOOL]: tool({
      description: `Записать человека на созвон с экспертом. Только на время, которое человек выбрал сам, из ${CALL_FREE_TIMES_TOOL}.`,
      inputSchema: z.object({ start: z.string().describe(`start выбранного времени из ${CALL_FREE_TIMES_TOOL}`) }),
      execute: async ({ start }) => {
        const result = await port.book(chat, start);
        if (!result.ok) return { ok: false as const, error: REFUSALS[result.reason], ...(result.booking && { booking: view(result.booking, result.timeZone) }) };
        return {
          ok: true as const,
          booking: view(result.booking, result.timeZone),
          next: "Человек записан. За час до созвона он получит напоминание" + (result.booking.meetingLink ? " со ссылкой на встречу." : "."),
        };
      },
    }),
    [CHANGE_CALL_TOOL]: tool({
      description: "Перенести или отменить запись человека на созвон, когда он сам об этом просит. Перенос — только на время из " + CALL_FREE_TIMES_TOOL + ".",
      inputSchema: z.object({
        action: z.enum(["reschedule", "cancel"]),
        start: z.string().optional().describe(`Для переноса: start нового времени из ${CALL_FREE_TIMES_TOOL}`),
      }),
      execute: async ({ action, start }) => {
        if (action === "cancel") {
          const result = await port.cancel(chat);
          return result.ok ? { ok: true as const, next: "Запись отменена, эксперт узнает об этом." } : { ok: false as const, error: REFUSALS.no_booking };
        }
        if (!start) return { ok: false as const, error: REFUSALS.bad_time };
        const result = await port.reschedule(chat, start);
        if (!result.ok) return { ok: false as const, error: REFUSALS[result.reason] };
        return { ok: true as const, booking: view(result.booking, result.timeZone), next: "Запись перенесена, эксперт узнает об этом." };
      },
    }),
  };
}
