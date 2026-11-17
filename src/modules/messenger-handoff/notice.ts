import { CHANNEL_LABELS, type ChannelKind } from "../channels/channel";

/** Начало служебного сообщения агенту о переходе: по нему тестовая модель узнаёт ход продолжения. */
export const HANDOFF_NOTICE_MARK = "Человек перешёл из веб-чата";

/** Служебное сообщение агенту при первом «Старте» в мессенджере: он пишет первым, продолжая разговор. */
export function handoffNotice(channel: ChannelKind): string {
  return (
    `${HANDOFF_NOTICE_MARK} в ${CHANNEL_LABELS[channel]} по кнопке. Разговор тот же: продолжи его с того места, ` +
    "где остановились, одним сообщением. Не знакомься и не начинай заново."
  );
}
