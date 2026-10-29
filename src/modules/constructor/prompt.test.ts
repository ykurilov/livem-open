import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const prompt = readFileSync(path.join(process.cwd(), "prompts", "constructor.md"), "utf8");

describe("контракт инструкции конструктора", () => {
  it("сохраняет операции редактирования и отдельное основное instruction", () => {
    for (const name of ["instruction", "put_flow", "put_state", "set_start", "remove_state", "replace_fragment", "attach_field", "create_field"])
      expect(prompt).toContain(name);
    expect(prompt).not.toMatch(/update_stage|set_program|remove_program|startDay|isSale/);
  });

  it("сохраняет ограничения графа: конечная нода, finish_dialog, @return и окно судьи", () => {
    for (const text of ["Нода без выходов — конечная", "finish_dialog", "@return", "anyState", "последние 6 реплик", "1500 знаков"])
      expect(prompt).toContain(text);
    expect(prompt).toMatch(/judge[^\n]*сохранение отклонит/);
  });

  it("сохраняет действующий контракт программы и ограничение сообщений первым", () => {
    for (const text of ["от 2 до 14 дней", "put_schedule", "remove_schedule", "deadlineState", "from=program_day", "untilProgramDay=1", "firstMessages.maxPerDayByDay=[3,2]", "put_side_tasks"])
      expect(prompt).toContain(text);
  });

  it("сохраняет границы инструментов консультанта и коротких ссылок", () => {
    for (const text of ["set_text_link", "{text}", "{type}", "1200 знаков", "text_link", "sale_answer"])
      expect(prompt).toContain(text);
    expect(prompt).toMatch(/отправка файлов[^\n]*нет/);
    expect(prompt).toMatch(/Публикует лидмагнит[^\n]*только эксперт/);
  });

  it("не обучает через демонстрационный сценарий или подсчёт знаков вопроса", () => {
    expect(prompt).toMatch(/Не добавляй в промпты[^\n]*без прямой просьбы эксперта/);
    expect(prompt).not.toMatch(/```|Твоё первое приложение|ровно один знак|Анна ждёт|Кирилл напишет/);
  });

  it("сохраняет стабильный текст для кэша без дат и динамических подстановок", () => {
    expect(prompt).not.toMatch(/\{\{|\$\{|%[sd]/);
    expect(prompt).not.toMatch(/\b20\d\d-\d\d-\d\d\b|\b\d{1,2}\.\d{1,2}\.20\d\d\b/);
  });
});
