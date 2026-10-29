import { describe, expect, it } from "vitest";
import type { SideTask } from "../lead-magnets/settings";
import { nextSideTasks, openSideTasks, SIDE_TASK_GAP_MESSAGES, SIDE_TASK_MAX_ASKS } from "./side-tasks";

const tasks: SideTask[] = [
  { id: "city", task: "Узнать город", fieldId: null, when: "" },
  { id: "review", task: "Попросить короткий отзыв", fieldId: null, when: "когда доволен результатом" },
];

describe("попутные задачи", () => {
  it("пока ни одной не задавали — открыты все", () => {
    expect(openSideTasks(tasks, {}, 1).map((task) => task.id)).toEqual(["city", "review"]);
  });

  it("после попутного вопроса — пауза не меньше 5 сообщений человека", () => {
    expect(SIDE_TASK_GAP_MESSAGES).toBe(5);
    const state = nextSideTasks({}, { taskId: "city", status: "asked" }, 4);
    expect(openSideTasks(tasks, state, 5)).toEqual([]);
    expect(openSideTasks(tasks, state, 8)).toEqual([]);
    expect(openSideTasks(tasks, state, 9).map((task) => task.id)).toEqual(["city", "review"]);
  });

  it("человек дважды пропустил вопрос — задача больше не всплывает, другие открыты", () => {
    expect(SIDE_TASK_MAX_ASKS).toBe(2);
    const once = nextSideTasks({}, { taskId: "city", status: "asked" }, 1);
    expect(openSideTasks(tasks, once, 10).map((task) => task.id)).toEqual(["city", "review"]);
    const twice = nextSideTasks(once, { taskId: "city", status: "asked" }, 10);
    expect(openSideTasks(tasks, twice, 30).map((task) => task.id)).toEqual(["review"]);
  });

  it("решённая задача больше не всплывает", () => {
    const state = nextSideTasks({}, { taskId: "city", status: "done" }, 3);
    expect(openSideTasks(tasks, state, 20).map((task) => task.id)).toEqual(["review"]);
    expect(nextSideTasks(state, { taskId: "city", status: "done" }, 4).done).toEqual(["city"]);
  });

  it("человек сам назвал ответ — задача решена, паузы нет: вопроса не было", () => {
    const state = nextSideTasks({}, { taskId: "city", status: "done" }, 3);
    expect(openSideTasks(tasks, state, 4).map((task) => task.id)).toEqual(["review"]);
  });
});
