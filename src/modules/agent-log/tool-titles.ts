import { webToolTitles } from "@ykurilov/agent-chat-web-tools/labels";

/**
 * Названия инструментов агентов так, как их видит эксперт: в плашках чата и во вкладке «Лог».
 * Конструктор берёт отсюда `title` своих инструментов — одно название на экране и у модели.
 */
export const TOOL_TITLES: Readonly<Record<string, string>> = {
  view_lead_magnet: "Просмотр лидмагнита",
  edit_lead_magnet: "Правка лидмагнита",
  read_test_conversation: "Чтение тестового разговора",
  reopen_test_conversation: "Продолжение тестового разговора",
  read_answer_corrections: "Чтение правок ответов",
  resolve_answer_corrections: "Разбор правок ответов",
  finish_dialog: "Завершение разговора",
  sale_answer: "Отказ от продукта",
  payment_promised: "Обещание оплатить",
  payment_check: "Проверка оплаты",
  flow_exit: "Переход по сценарию",
  flow_note: "Запись о человеке",
  find_videos: "Поиск ролика",
  show_video: "Показ ролика",
  find_images: "Поиск картинки",
  show_image: "Показ картинки",
  suggest_replies: "Кнопки с ответами",
  sales_card: "Заготовка эксперта",
  ...webToolTitles,
};

/** Название инструмента для эксперта; незнакомый — своим именем, чтобы его было видно, а не пустое место. */
export function toolTitle(name: string): string {
  return Object.hasOwn(TOOL_TITLES, name) ? TOOL_TITLES[name]! : name;
}

/** Причина перехода от сценария SDK: «вызван инструмент «finish_dialog»» → «вызван инструмент «Завершение разговора»». */
export function withToolTitles(text: string): string {
  return text.replace(/(инструмент )«([a-z0-9_]+)»/g, (_, prefix: string, name: string) => `${prefix}«${toolTitle(name)}»`);
}

/** Подписи плашек инструментов в чатах SDK — с названиями инструментов вместо служебных имён. */
export function chatLabelsWithToolTitles<Labels extends { toolRunning(name: string): string; toolDone(name: string): string; toolError(name: string): string }>(
  labels: Labels,
): Labels {
  return {
    ...labels,
    toolRunning: (name: string) => labels.toolRunning(toolTitle(name)),
    toolDone: (name: string) => labels.toolDone(toolTitle(name)),
    toolError: (name: string) => labels.toolError(toolTitle(name)),
  };
}
