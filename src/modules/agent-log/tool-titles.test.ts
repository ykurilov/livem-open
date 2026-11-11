import { russianLabels } from "@ykurilov/agent-chat-react";
import { describe, expect, it } from "vitest";
import { chatLabelsWithToolTitles, toolTitle, withToolTitles } from "./tool-titles";

describe("названия инструментов для эксперта", () => {
  it("служебное имя — по-русски, незнакомое — как есть", () => {
    expect(toolTitle("edit_lead_magnet")).toBe("Правка лидмагнита");
    expect(toolTitle("finish_dialog")).toBe("Завершение разговора");
    expect(toolTitle("web_search")).toBe("Поиск в интернете");
    expect(toolTitle("new_tool")).toBe("new_tool");
    expect(toolTitle("toString")).toBe("toString");
  });

  it("причина перехода сценария — без служебного имени", () => {
    expect(withToolTitles("вызван инструмент «finish_dialog»")).toBe("вызван инструмент «Завершение разговора»");
    expect(withToolTitles("Человек согласился")).toBe("Человек согласился");
  });

  it("плашка инструмента в чате — с названием, а не с именем", () => {
    const labels = chatLabelsWithToolTitles(russianLabels);
    expect(labels.toolDone("edit_lead_magnet")).not.toContain("edit_lead_magnet");
    expect(labels.toolDone("edit_lead_magnet")).toContain("Правка лидмагнита");
    expect(labels.toolRunning("view_lead_magnet")).toContain("Просмотр лидмагнита");
  });
});
