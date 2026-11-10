import type { MailingStatus } from "@/modules/mailings";

const MAILING_STATUS_LABELS: Record<MailingStatus, string> = {
  draft: "Черновик",
  scheduled: "Запланирована",
  sending: "Отправляется",
  done: "Отправлена",
  cancelled: "Отменена",
};

type BadgeVariant = "cool" | "neutral" | "success" | "warm";

const MAILING_STATUS_BADGES: Record<MailingStatus, BadgeVariant> = {
  draft: "neutral",
  scheduled: "cool",
  sending: "cool",
  done: "success",
  cancelled: "warm",
};

/**
 * Подпись состояния рассылки. Законченная, но не ушедшая ни одному человеку — не успех: при запуске никто не подошёл
 * под «Кому» или ни одно сообщение не доставлено.
 */
export function mailingStatusBadge(mailing: { status: MailingStatus; sentCount: number }): { label: string; variant: BadgeVariant } {
  if (mailing.status === "done" && mailing.sentCount === 0) return { label: "Никому не ушла", variant: "warm" };
  return { label: MAILING_STATUS_LABELS[mailing.status], variant: MAILING_STATUS_BADGES[mailing.status] };
}

export interface MailingHeadline {
  badge: { label: string; variant: BadgeVariant };
  /** Заголовок карточки: когда уйдёт, когда началась или что происходит сейчас. */
  title: string;
  /** Рассылка ещё ждёт своего времени: её можно отменить. */
  canCancel: boolean;
  /** Отправка идёт или вот-вот начнётся: страница перечитывает итог сама. */
  live: boolean;
}

/**
 * Что сказать о запущенной рассылке одним ответом. «Отправить сейчас» ставит время на «сейчас»: такую рассылку работник
 * берёт через секунды — это уже отправка, а не план, который можно спокойно отменить.
 */
export function mailingHeadline(
  mailing: { status: MailingStatus; scheduledAt: Date | null; startedAt: Date | null; sentCount: number },
  now: Date,
): MailingHeadline {
  const due = mailing.status === "scheduled" && (!mailing.scheduledAt || mailing.scheduledAt.getTime() <= now.getTime());
  if (due) return { badge: { label: MAILING_STATUS_LABELS.sending, variant: MAILING_STATUS_BADGES.sending }, title: "Отправка начинается", canCancel: false, live: true };
  const title =
    mailing.status === "scheduled" && mailing.scheduledAt
      ? `Уйдёт ${mskDateTime.format(mailing.scheduledAt)} по Москве`
      : mailing.startedAt
        ? `Началась ${mskDateTime.format(mailing.startedAt)} по Москве`
        : "Не отправлялась";
  return { badge: mailingStatusBadge(mailing), title, canCancel: mailing.status === "scheduled", live: mailing.status === "sending" };
}

export const mskDateTime = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
