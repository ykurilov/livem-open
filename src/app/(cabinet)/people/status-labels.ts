import type { PassageStatus } from "@/modules/conversations";

export const PASSAGE_STATUS_LABELS: Record<PassageStatus, string> = {
  active: "Идёт",
  completed: "Завершил",
  not_completed: "Не завершил",
  blocked: "Заблокировал",
  term_ended: "Срок вышел",
};

export const PASSAGE_STATUS_BADGES: Record<PassageStatus, "cool" | "success" | "neutral" | "warm" | "danger"> = {
  active: "cool",
  completed: "success",
  not_completed: "neutral",
  blocked: "danger",
  term_ended: "neutral",
};
