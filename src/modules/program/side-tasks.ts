import type { PassageSideTasks } from "../consultant/schema";
import type { SideTask } from "../lead-magnets/settings";

/** После попутного вопроса следующий — не раньше, чем через столько сообщений человека. */
export const SIDE_TASK_GAP_MESSAGES = 5;

/** Человек пропустил попутный вопрос столько раз — больше его не задаём: не анкета. */
export const SIDE_TASK_MAX_ASKS = 2;

/** Задачи, которые консультант может поднять сейчас: не решённые и только если пауза после прошлого вопроса прошла. */
export function openSideTasks(tasks: readonly SideTask[], state: PassageSideTasks, personMessageCount: number): SideTask[] {
  const askedAt = state.lastAskedAtMessage;
  if (askedAt !== undefined && personMessageCount - askedAt < SIDE_TASK_GAP_MESSAGES) return [];
  const done = new Set(state.done ?? []);
  return tasks.filter((task) => !done.has(task.id) && (state.asks?.[task.id] ?? 0) < SIDE_TASK_MAX_ASKS);
}

/**
 * Состояние после вызова `side_task`. `asked` — консультант задал вопрос: отсчёт паузы с этого сообщения.
 * `done` — задача решена (человек мог ответить и сам, без вопроса): паузу не трогает.
 */
export function nextSideTasks(
  state: PassageSideTasks,
  input: { taskId: string; status: "asked" | "done" },
  personMessageCount: number,
): PassageSideTasks {
  if (input.status === "asked")
    return { ...state, lastAskedAtMessage: personMessageCount, asks: { ...state.asks, [input.taskId]: (state.asks?.[input.taskId] ?? 0) + 1 } };
  const done = state.done ?? [];
  return { ...state, done: done.includes(input.taskId) ? done : [...done, input.taskId] };
}
