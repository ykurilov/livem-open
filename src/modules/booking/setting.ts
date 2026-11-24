import { z } from "zod";
import { LEAD_MAGNET_EVENTS } from "../flows/catalog";

export const CALL_BOOKING_WHEN_MAX_LENGTH = 1000;
export const CALL_BOOKING_ABOUT_MAX_LENGTH = 2000;
export const CALL_BOOKING_LINK_MAX_LENGTH = 500;

const isWebLink = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

/**
 * «Запись на созвон»: агент в уместный момент предлагает созвон с экспертом, называет свободное время из календаря
 * раздела «Созвоны» и записывает человека. `when` — слова эксперта, когда предложить; `about` — что сказать о созвоне
 * (формат, длительность, что будет); `meetingLink` — ссылка на встречу, её человек получит в напоминании. Нет поля
 * или выключено — инструментов записи нет.
 */
export const callBookingSchema = z
  .object({
    enabled: z.boolean(),
    when: z.string().max(CALL_BOOKING_WHEN_MAX_LENGTH, `«Когда предложить» — не длиннее ${CALL_BOOKING_WHEN_MAX_LENGTH} знаков`),
    about: z.string().max(CALL_BOOKING_ABOUT_MAX_LENGTH, `«Что сказать о созвоне» — не длиннее ${CALL_BOOKING_ABOUT_MAX_LENGTH} знаков`),
    meetingLink: z
      .string()
      .trim()
      .max(CALL_BOOKING_LINK_MAX_LENGTH, `Ссылка на встречу — не длиннее ${CALL_BOOKING_LINK_MAX_LENGTH} знаков`)
      .refine((link) => link === "" || isWebLink(link), "«Запись на созвон»: ссылка на встречу — адрес, который начинается с https://"),
  })
  .superRefine((setting, ctx) => {
    if (setting.enabled && !setting.when.trim()) ctx.addIssue({ code: "custom", message: "«Запись на созвон»: впишите, когда предложить созвон" });
  });

export type CallBookingSetting = z.infer<typeof callBookingSchema>;

export const DEFAULT_CALL_BOOKING: CallBookingSetting = { enabled: false, when: "", about: "", meetingLink: "" };

/** Настройка, если запись включена; иначе `null`. */
export function enabledCallBooking(settings: { callBooking?: CallBookingSetting | undefined }): CallBookingSetting | null {
  const setting = settings.callBooking;
  return setting?.enabled && setting.when.trim() ? setting : null;
}

/** Имя события сценария «записался на созвон» (`{ type: "event", event: "app", name }`). */
export const CALL_BOOKED_EVENT = LEAD_MAGNET_EVENTS.callBooked;
