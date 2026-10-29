import type { MailingStatus } from "@/modules/mailings";

export const MAILING_STATUS_LABELS: Record<MailingStatus, string> = {
  draft: "Черновик",
  scheduled: "Запланирована",
  sending: "Отправляется",
  done: "Отправлена",
  cancelled: "Отменена",
};

export const MAILING_STATUS_BADGES: Record<MailingStatus, "cool" | "neutral" | "success" | "warm"> = {
  draft: "neutral",
  scheduled: "cool",
  sending: "cool",
  done: "success",
  cancelled: "warm",
};

export const mskDateTime = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
