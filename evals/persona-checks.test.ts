// Сбой персонажа — отдельный статус: персонаж вышел из роли, и разговор не годится для оценки агента.
import { describe, expect, it } from "vitest";
import { checkScenario } from "./checks";
import { personaChecks } from "./persona-checks";
import { clientRun, consultantTurn, scenarioRun } from "./test-fixtures";
import type { CheckResult, ScenarioRun } from "./types";

const clientCheck = (run: ScenarioRun, index = 1): CheckResult => personaChecks(run).find((check) => check.id === "persona_client_role" && check.subject.startsWith(`клиент ${index}:`))!;
const expertCheck = (run: ScenarioRun): CheckResult => personaChecks(run).find((check) => check.id === "persona_expert_role")!;

const withClientSaying = (texts: string[], overrides: Parameters<typeof clientRun>[0] = {}) =>
  scenarioRun({ clients: [clientRun({ turns: [consultantTurn({ client: "/start code" }), ...texts.map((client) => consultantTurn({ client }))], ...overrides })] });

describe("personaChecks", () => {
  it("обычный разговор — персонажи держали роль", () => {
    const run = scenarioRun();
    expect(expertCheck(run).status).toBe("pass");
    expect(clientCheck(run).status).toBe("pass");
  });

  it("реплика не по-русски — сбой персонажа", () => {
    const check = clientCheck(withClientSaying(["Ну да", "I think I should leave now, thanks for the chat"]));
    expect(check.status).toBe("persona_broke");
    expect(check.details).toContain("не по-русски");
    expect(clientCheck(withClientSaying(["89361234567", "ok", "https://t.me/anna"])).status).toBe("pass");
  });

  it("персонаж пишет за бота или ремарками — сбой", () => {
    expect(clientCheck(withClientSaying(["Ок.\nБот: Отлично, записываю вас!"])).details).toContain("за собеседника");
    expect(clientCheck(withClientSaying(["*уходит из чата*"])).details).toContain("ремарка");
  });

  it("выход из роли и названия инструментов в реплике — сбой", () => {
    expect(clientCheck(withClientSaying(["Как языковая модель, я не могу"])).status).toBe("persona_broke");
    expect(clientCheck(withClientSaying(["Ладно, вызываю leave_chat"])).details).toContain("leave_chat");
    expect(clientCheck(withClientSaying(["Мой персонаж бы тут ушёл"])).status).toBe("persona_broke");
    expect(clientCheck(withClientSaying(["Персонаж в игре теперь машет рукой, когда ребёнок угадал"])).status).toBe("pass");
  });

  it("попрощался, а отметил «ушёл не прощаясь» — сбой: консультанту засчитали бы, что завершать было нечего", () => {
    const check = clientCheck(withClientSaying(["Спасибо, не надо, до свидания!"], { endedBy: "client_left", leftMidConversation: true }));
    expect(check.status).toBe("persona_broke");
    expect(check.details).toContain("saidGoodbye");
    expect(clientCheck(withClientSaying(["Ну ладно. Пока!"], { leftMidConversation: true })).status).toBe("persona_broke");
    expect(clientCheck(withClientSaying(["Я пока не уверена, что мне нужен дизайнер."], { leftMidConversation: true })).status).toBe("pass");
  });

  it("одна и та же реплика три раза подряд — персонаж зациклился", () => {
    expect(clientCheck(withClientSaying(["Не знаю", "Не знаю", "Не знаю"])).details).toContain("три раза");
    expect(clientCheck(withClientSaying(["Не знаю", "Да", "Не знаю"])).status).toBe("pass");
    // Молчун, который шлёт точку, — в роли
    expect(clientCheck(withClientSaying([".", ".", "."])).status).toBe("pass");
  });

  it("текст после инструмента выхода и переспрос не по-русски, замеченные персонажем, — сбой", () => {
    const check = clientCheck(withClientSaying(["Пока"], { personaSlips: ["реплика 1: текст после leave_chat: «Итог: клиент ушёл»"] }));
    expect(check.status).toBe("persona_broke");
    expect(check.details).toContain("после leave_chat");
  });

  it("замечания персонажа из прогона попадают в проверку эксперта", () => {
    const base = scenarioRun();
    const run = scenarioRun({ building: { ...base.building, personaSlips: ["реплика 2: текст после finish_building: «Итог»"] } });
    expect(expertCheck(run).details).toContain("после finish_building");
  });

  it("эксперт пишет, что проверил бота в тесте, — сбой персонажа, а не косяк конструктора", () => {
    const base = scenarioRun();
    const run = scenarioRun({ building: { ...base.building, turns: [{ ...base.building.turns[0]!, expert: "Я проверила бота в тесте, он отвечает как надо" }] } });
    expect(expertCheck(run).status).toBe("persona_broke");
  });

  it("лидмагнит из файла — эксперта нет, проверки эксперта нет", () => {
    const base = scenarioRun();
    expect(expertCheck(scenarioRun({ building: { ...base.building, turns: [], endedBy: "from_file" } })).status).toBe("skip");
  });

  it("проверки персонажей входят в проверки сценария", () => {
    const ids = checkScenario(scenarioRun()).map((check) => check.id);
    expect(ids).toContain("persona_expert_role");
    expect(ids).toContain("persona_client_role");
  });
});
