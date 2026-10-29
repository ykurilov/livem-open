import { describe, expect, it } from "vitest";
import type { FieldDefinition } from "../people";
import { LEAD_MAGNET_TOOLS, clientCardFieldOf, leadMagnetFlowCatalog } from "./catalog";

const field = (patch: Partial<FieldDefinition>): FieldDefinition => ({
  id: "00000000-0000-4000-8000-000000000001",
  name: "Поле",
  type: "text",
  options: [],
  description: "",
  ...patch,
});

describe("каталог сценария лидмагнита", () => {
  it("инструменты приложения: итог разговора, ответ на продажу, просмотр ссылки; своих событий нет: день программы — таймер SDK", () => {
    expect(LEAD_MAGNET_TOOLS).toEqual({ finishDialog: "finish_dialog", saleAnswer: "sale_answer", personLinkView: "person_link_view" });
    expect(leadMagnetFlowCatalog([])).toEqual({
      tools: ["finish_dialog", "sale_answer", "person_link_view"],
      toolLabels: { finish_dialog: "Завершить разговор", sale_answer: "Записать отказ от продукта", person_link_view: "Открыть ссылку человека" },
      events: [],
      widgets: [],
      fields: [],
    });
  });

  it("поля словаря «Базы»: название, тип («да/нет» → boolean), варианты выбора", () => {
    const catalog = leadMagnetFlowCatalog([
      field({ id: "a", name: "Подписан", type: "boolean" }),
      field({ id: "b", name: "Опыт", type: "choice", options: ["нет", "есть"] }),
      field({ id: "c", name: "Возраст", type: "number" }),
    ]);
    expect(catalog.fields).toEqual([
      { id: "a", title: "Подписан", type: "boolean" },
      { id: "b", title: "Опыт", type: "choice", options: ["нет", "есть"] },
      { id: "c", title: "Возраст", type: "number" },
    ]);
  });

  it("поле карточки клиента из поля словаря: id словаря, описание — подсказка модели, не устаревает", () => {
    expect(clientCardFieldOf(field({ id: "x", name: "Чем занимается", description: "Профессия одной фразой" }))).toEqual({
      id: "x",
      name: "Чем занимается",
      about: "Профессия одной фразой",
      type: "text",
      options: [],
      refreshAfterMonths: null,
    });
  });
});
