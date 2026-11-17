import { z } from "zod";
import { MESSENGER_KINDS } from "../channels/channel";
import { LEAD_MAGNET_EVENTS } from "../flows/catalog";

/** Мессенджер, куда веб-чат переводит разговор. */
export type HandoffMessenger = (typeof MESSENGER_KINDS)[number];

export const MESSENGER_HANDOFF_WHEN_MAX_LENGTH = 1000;

/**
 * «Переход в мессенджер»: в веб-чате консультант в уместный момент показывает кнопки мессенджеров вместо поля ввода, и
 * разговор продолжается в боте эксперта. `when` — слова эксперта, когда предложить; `channels` — какие мессенджеры
 * предлагать (кнопка есть, только если лидмагнит опубликован в этом мессенджере). В настройках до поля его нет — выключено.
 */
export const messengerHandoffSchema = z
  .object({
    enabled: z.boolean(),
    when: z.string().max(MESSENGER_HANDOFF_WHEN_MAX_LENGTH, `«Когда предложить» — не длиннее ${MESSENGER_HANDOFF_WHEN_MAX_LENGTH} знаков`),
    channels: z.array(z.enum(MESSENGER_KINDS)).transform((channels) => MESSENGER_KINDS.filter((kind) => channels.includes(kind))),
  })
  .superRefine((setting, ctx) => {
    if (!setting.enabled) return;
    if (!setting.when.trim()) ctx.addIssue({ code: "custom", message: "«Переход в мессенджер»: впишите, когда предложить перейти" });
    if (setting.channels.length === 0) ctx.addIssue({ code: "custom", message: "«Переход в мессенджер»: отметьте хотя бы один мессенджер" });
  });

export type MessengerHandoffSetting = z.infer<typeof messengerHandoffSchema>;

/** Выключено, все мессенджеры отмечены: так блок выглядит, пока эксперт его не трогал. */
export const DEFAULT_MESSENGER_HANDOFF: MessengerHandoffSetting = { enabled: false, when: "", channels: [...MESSENGER_KINDS] };

/** Настройка, если переход включён; иначе `null`. */
export function enabledMessengerHandoff(settings: { messengerHandoff?: MessengerHandoffSetting | undefined }): MessengerHandoffSetting | null {
  const setting = settings.messengerHandoff;
  return setting?.enabled && setting.when.trim() && setting.channels.length > 0 ? setting : null;
}

/** Имя события сценария «перешёл в мессенджер» (`{ type: "event", event: "app", name }`). */
export const MESSENGER_HANDOFF_EVENT = LEAD_MAGNET_EVENTS.messengerHandoff;
