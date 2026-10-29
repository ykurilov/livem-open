import type { ClientCardField, FlowCatalog, FlowCatalogField, FlowFieldType } from "@ykurilov/agent-chat-flows/format";
import type { FieldDefinition, FieldType } from "../people";

/** Инструменты приложения, на которые ссылается сценарий лидмагнита. */
export const LEAD_MAGNET_TOOLS = {
  /** Итог разговора: событие этого инструмента ведёт в конечную ноду «Итог». */
  finishDialog: "finish_dialog",
  /** Ответ человека на предложение продукта: только в ноде с меткой «продажа». */
  saleAnswer: "sale_answer",
  /** Просмотр ссылки человека (`createPersonLinkTool` из web-tools). */
  personLinkView: "person_link_view",
} as const;

/** Названия инструментов на доске: в сценарии и при работе остаются служебные имена. */
const LEAD_MAGNET_TOOL_LABELS: Record<(typeof LEAD_MAGNET_TOOLS)[keyof typeof LEAD_MAGNET_TOOLS], string> = {
  finish_dialog: "Завершить разговор",
  sale_answer: "Записать отказ от продукта",
  person_link_view: "Открыть ссылку человека",
};

/** Типы полей «Базы» и карточки клиента SDK совпадают по смыслу: «да/нет» — `boolean`. */
const FLOW_FIELD_TYPE: Record<FieldType, FlowFieldType> = {
  text: "text",
  number: "number",
  choice: "choice",
  boolean: "boolean",
};

function catalogFieldOf(field: FieldDefinition): FlowCatalogField {
  const type = FLOW_FIELD_TYPE[field.type];
  return type === "choice" ? { id: field.id, title: field.name, type, options: field.options } : { id: field.id, title: field.name, type };
}

/** Поле карточки клиента из поля словаря: тот же id, описание — подсказка модели. */
export function clientCardFieldOf(field: FieldDefinition): ClientCardField {
  return {
    id: field.id,
    name: field.name,
    about: field.description,
    type: FLOW_FIELD_TYPE[field.type],
    options: field.type === "choice" ? field.options : [],
    refreshAfterMonths: null,
  };
}

/**
 * Что приложение объявляет сценарию: одно и то же для доски, конструктора, `lm.sh` и проверки при сохранении.
 * `fields` — словарь «Базы»: доска предлагает из него поля карточки. Своих событий нет: день программы — таймер SDK.
 */
export function leadMagnetFlowCatalog(fields: readonly FieldDefinition[] = []): FlowCatalog {
  return { tools: Object.values(LEAD_MAGNET_TOOLS), toolLabels: LEAD_MAGNET_TOOL_LABELS, events: [], widgets: [], fields: fields.map(catalogFieldOf) };
}
