import { describe, expect, it } from "vitest";
import { answerActions, CORRECTION_CONTEXT_CHARS, correctionContext, type CorrectionBranchMessage } from "./context";

type Parts = CorrectionBranchMessage["parts"];

const say = (id: string, role: "user" | "assistant", text: string, stage?: string): CorrectionBranchMessage => ({
  id,
  role,
  parts: [{ type: "text", text }],
  ...(stage ? { stage } : {}),
});

const toolPart = (name: string, input: unknown, output: unknown) => ({ type: `tool-${name}`, toolCallId: `call-${name}`, state: "output-available", input, output }) as unknown as Parts[number];

describe("кусок разговора перед ответом", () => {
  it("до 6 реплик перед ответом, по порядку, с нодой; сам ответ и то, что после, не входят", () => {
    const branch = Array.from({ length: 9 }, (_, index) => say(`m${index}`, index % 2 ? "assistant" : "user", `реплика ${index}`, index < 5 ? "Знакомство" : "Продажа"));
    branch.push(say("answer", "assistant", "исправленный ответ", "Продажа"), say("after", "user", "потом"));

    expect(correctionContext(branch, "answer")).toEqual([
      { role: "assistant", text: "реплика 3", stage: "Знакомство" },
      { role: "user", text: "реплика 4", stage: "Знакомство" },
      { role: "assistant", text: "реплика 5", stage: "Продажа" },
      { role: "user", text: "реплика 6", stage: "Продажа" },
      { role: "assistant", text: "реплика 7", stage: "Продажа" },
      { role: "user", text: "реплика 8", stage: "Продажа" },
    ]);
  });

  it("реплики без текста пропускаются; текстовые части склеиваются; без ноды — без отметки", () => {
    const branch: CorrectionBranchMessage[] = [
      { id: "a", role: "assistant", parts: [toolPart("show_video", { id: "v" }, { видео: { название: "Урок" } })] },
      { id: "b", role: "user", parts: [{ type: "text", text: "Первая" }, { type: "text", text: "Вторая" }] },
      say("answer", "assistant", "ответ"),
    ];

    expect(correctionContext(branch, "answer")).toEqual([{ role: "user", text: "Первая\n\nВторая" }]);
  });

  it("не больше 4000 знаков: старые реплики отбрасываются, слишком длинная последняя обрезается с начала", () => {
    const long = "я".repeat(2500);
    const branch = [say("a", "user", long), say("b", "assistant", long), say("c", "user", "коротко"), say("answer", "assistant", "ответ")];
    const context = correctionContext(branch, "answer");
    expect(context.map((line) => line.text.length)).toEqual([2500, "коротко".length]);
    expect(context.reduce((sum, line) => sum + line.text.length, 0)).toBeLessThanOrEqual(CORRECTION_CONTEXT_CHARS);

    const huge = `начало ${"ю".repeat(5000)} конец`;
    const [only] = correctionContext([say("a", "user", huge), say("answer", "assistant", "ответ")], "answer");
    expect(only!.text.length).toBeLessThanOrEqual(CORRECTION_CONTEXT_CHARS);
    expect(only!.text.startsWith("…")).toBe(true);
    expect(only!.text.endsWith("конец")).toBe(true);
  });

  it("первое сообщение и ответ не из ветки — пустой кусок", () => {
    expect(correctionContext([say("answer", "assistant", "здравствуйте")], "answer")).toEqual([]);
    expect(correctionContext([say("a", "user", "привет")], "нет такого")).toEqual([]);
  });
});

describe("действия консультанта в ответе словами", () => {
  it("сохранил поле, записал факт, прислал ролик и картинку, завершил разговор — по порядку", () => {
    const parts: Parts = [
      toolPart("flow_note", { field: "name", value: "Анна" }, "Записано: «Имя» = Анна."),
      toolPart("flow_note", { fact: "ведёт блог" }, "Записано: ведёт блог."),
      toolPart("show_video", { id: "v1" }, { видео: { id: "v1", название: "Как начать" } }),
      toolPart("show_image", { id: "i1" }, { картинка: { id: "i1", название: "Схема" } }),
      { type: "text", text: "Вот ответ" },
      toolPart("finish_dialog", { goal: "г", stuckAt: "з", chosenStep: "ш", outcome: "agreed" }, { ok: true, next: "Разговор завершён." }),
    ];

    expect(answerActions(parts)).toEqual([
      "сохранил поле «Имя»",
      "записал факт о человеке",
      "прислал ролик «Как начать»",
      "прислал картинку «Схема»",
      "завершил разговор",
    ]);
  });

  it("неудачные вызовы и вызовы без результата — не действия; прочие инструменты не называются", () => {
    const parts: Parts = [
      toolPart("flow_note", { field: "age", value: "много" }, "Не записано: «Возраст» — число, а пришло «много»"),
      toolPart("flow_note", { asked: "age" }, "Отмечено: про «Возраст» спросил."),
      toolPart("show_video", { id: "x" }, { отказ: "Такого видео нет в каталоге" }),
      { type: "tool-show_image", toolCallId: "c", state: "output-error", input: { id: "i" }, errorText: "нет" } as unknown as Parts[number],
      { type: "tool-finish_dialog", toolCallId: "f", state: "input-available", input: {} } as unknown as Parts[number],
      toolPart("find_videos", { query: "q" }, { видео: [] }),
      { type: "dynamic-tool", toolName: "finish_dialog", toolCallId: "d", state: "output-available", input: {}, output: { ok: true } } as unknown as Parts[number],
    ];

    expect(answerActions(parts)).toEqual(["завершил разговор"]);
  });

  it("инструмент, после которого сценарий сменил ноду: результат в обёртке сценария — действие то же", () => {
    const parts: Parts = [
      toolPart("show_video", { id: "v1" }, { result: { видео: { id: "v1", название: "Как начать" } }, flow: "Переход: «А» → «Б»." }),
      toolPart("finish_dialog", { outcome: "agreed" }, { result: { ok: true, next: "Разговор завершён." }, flow: "Переход: «Знакомство» → «Итог»." }),
    ];

    expect(answerActions(parts)).toEqual(["прислал ролик «Как начать»", "завершил разговор"]);
  });

  it("ответ без действий — пустой список", () => {
    expect(answerActions([{ type: "text", text: "Просто ответ" }])).toEqual([]);
  });
});
