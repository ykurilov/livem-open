import { describe, expect, it } from "vitest";
import { checkScenario } from "./checks";
import { clientRun, consultantTurn, flowStart, plainSilent, programClient, programRun, said, scenarioRun, silent, transition } from "./test-fixtures";
import { SILENCE_TILL_END, type CheckResult, type ClientRun, type ConsultantTurn, type FlowTransitionRecord, type ScenarioRun } from "./types";

const find = (checks: CheckResult[], id: string, subject = "сценарий") => {
  const check = checks.find((entry) => entry.id === id && entry.subject === subject);
  if (!check) throw new Error(`Нет проверки ${id} для «${subject}»: ${checks.map((entry) => `${entry.id}/${entry.subject}`).join(", ")}`);
  return check;
};
const CLIENT_1 = "клиент 1: Сомневающаяся Марина";

describe("checkScenario", () => {
  it("удачный сценарий проходит все проверки", () => {
    const failed = checkScenario(scenarioRun()).filter((check) => check.status === "fail");
    expect(failed).toEqual([]);
  });

  it("лидмагнит не сохранился — провал, клиентские проверки пропущены", () => {
    const checks = checkScenario(scenarioRun({ settings: null, clients: [] }));
    expect(find(checks, "lead_magnet_saved").status).toBe("fail");
    expect(find(checks, "required_settings").status).toBe("skip");
  });

  it("пустые обязательные поля перечислены", () => {
    const base = scenarioRun();
    const check = find(checkScenario({ ...base, settings: { ...base.settings!, instruction: " ", farewellMessage: "" } }), "required_settings");
    expect(check.status).toBe("fail");
    expect(check.details).toContain("instruction");
    expect(check.details).toContain("farewellMessage");
  });

  it("пустое описание карточки и имя-заглушка — провал обязательных настроек", () => {
    const base = scenarioRun();
    const required = (patch: Partial<NonNullable<ScenarioRun["settings"]>>) => find(checkScenario({ ...base, settings: { ...base.settings!, ...patch } }), "required_settings");
    expect(required({ cardDescription: "  " })).toMatchObject({ status: "fail", details: expect.stringContaining("cardDescription") });
    expect(required({ name: "Новый лидмагнит" })).toMatchObject({ status: "fail", details: expect.stringContaining("name") });
    expect(required({}).status).toBe("pass");
  });

  it("сбои провайдера, закрытые запасным путём, не валят проверку, но видны в подробностях", () => {
    const run = scenarioRun({ agentLogRecovered: ["модель deepseek-4.1-flash (together → deepseek): Credit limit exceeded"] });
    const check = find(checkScenario(run), "no_errors");
    expect(check.status).toBe("pass");
    expect(check.details).toContain("закрыл запасной путь: 1");
    expect(check.details).toContain("together → deepseek");
  });

  it("ошибки прогона, журнала, конструктора и передача эксперту — в одной проверке", () => {
    const base = scenarioRun();
    const run = scenarioRun({
      runnerErrors: ["клиент 2: таймаут"],
      agentLogErrors: ["consultant model: 503"],
      building: { ...base.building, turns: [{ ...base.building.turns[0]!, status: "error", error: "overloaded" }] },
      clients: [clientRun({ passage: { ...clientRun().passage!, handoverReason: "провайдер недоступен" } })],
    });
    const check = find(checkScenario(run), "no_errors");
    expect(check.status).toBe("fail");
    for (const text of ["таймаут", "503", "overloaded", "провайдер недоступен"]) expect(check.details).toContain(text);
  });

  it("упавший вызов инструмента — ошибка", () => {
    const run = scenarioRun({
      clients: [clientRun({ turns: [consultantTurn({ tools: [{ name: "remember", input: {}, error: "нет поля" }] })], endedBy: "reply_limit" })],
    });
    expect(find(checkScenario(run), "no_errors").details).toContain("remember");
  });

  it("вызов вернул ok:false — тоже ошибка, у конструктора и у консультанта", () => {
    const base = scenarioRun();
    const run = scenarioRun({
      building: { ...base.building, turns: [{ ...base.building.turns[0]!, tools: [{ name: "edit_lead_magnet", input: {}, output: { ok: false, error: "кусок не найден" } }, { name: "edit_lead_magnet", input: {}, output: { ok: true } }] }] },
      clients: [clientRun({ turns: [consultantTurn({ tools: [{ name: "go_to_stage", input: {}, output: { ok: false, error: "Нет этапа «booking»" } }] })], endedBy: "reply_limit" })],
    });
    const check = find(checkScenario(run), "no_errors");
    expect(check.status).toBe("fail");
    expect(check.details).toContain("кусок не найден");
    expect(check.details).toContain("Нет этапа «booking»");
  });

  describe("конструктор сказал, что сохранил, — в ходе есть удачная правка", () => {
    const withTurn = (reply: string, tools: ScenarioRun["building"]["turns"][number]["tools"]) => {
      const base = scenarioRun();
      return scenarioRun({ building: { ...base.building, turns: [{ ...base.building.turns[0]!, reply, tools }] } });
    };

    it("«Записал» с удачной правкой и обсуждение без «записал» — норма", () => {
      expect(find(checkScenario(scenarioRun()), "constructor_save_claim").status).toBe("pass");
      expect(find(checkScenario(withTurn("Понял. Какой следующий шаг?", [])), "constructor_save_claim").status).toBe("pass");
    });

    it("«Записал» без вызова или только с ok:false и упавшим вызовом — провал с цитатой", () => {
      for (const tools of [[], [{ name: "edit_lead_magnet", input: {}, output: { ok: false, error: "нет" } }], [{ name: "edit_lead_magnet", input: {}, error: "Invalid input" }]]) {
        const check = find(checkScenario(withTurn("Записал: встреча бесплатная.", tools)), "constructor_save_claim");
        expect(check.status).toBe("fail");
        expect(check.details).toContain("ход 1: «Записал: встреча бесплатная.»");
      }
    });
  });

  describe("ссылки", () => {
    const LINK = "https://yoga-anna.ru/probnoe";
    const withLink = (bot: string, outcome = "agreed") => {
      const base = scenarioRun();
      const client = clientRun();
      const turns = [...client.turns];
      turns[1] = consultantTurn({ client: "Йогой", bot: [bot] });
      return scenarioRun({
        scenario: { ...base.scenario, expertLink: LINK },
        settings: { ...base.settings!, instruction: `Ты консультант. Ссылка на запись: ${LINK}` },
        clients: [clientRun({ turns, passage: { ...client.passage!, summary: { ...client.passage!.summary!, outcome: outcome as "agreed" } } })],
      });
    };

    it("ссылка эксперта дошла дословно — норма; согласился, а ссылки нет — провал; отказался — пропуск", () => {
      expect(find(checkScenario(withLink(`Записаться: ${LINK}`)), "expert_link_delivered", CLIENT_1).status).toBe("pass");
      expect(find(checkScenario(withLink("Записаться можно на сайте")), "expert_link_delivered", CLIENT_1).status).toBe("fail");
      expect(find(checkScenario(withLink("Хорошо, удачи", "declined")), "expert_link_delivered", CLIENT_1).status).toBe("skip");
      expect(find(checkScenario(scenarioRun()), "expert_link_delivered", CLIENT_1).status).toBe("skip");
    });

    it("ссылки, которой нет в настройках и репликах клиента, — провал с адресом; политика и ссылка из инструкции — норма", () => {
      expect(find(checkScenario(withLink(`Записаться: ${LINK}`)), "no_invented_links", CLIENT_1).status).toBe("pass");
      const check = find(checkScenario(withLink("Запись: https://yoga-anna.ru/zapis")), "no_invented_links", CLIENT_1);
      expect(check.status).toBe("fail");
      expect(check.details).toContain("https://yoga-anna.ru/zapis");
    });

    it("ссылка из результата инструмента (text_link) — не выдуманная", () => {
      const link = "https://appstudio.example.com/?idea=%D0%9A%D0%BE%D1%82&type=game";
      const run = withLink(`Откройте: ${link}`);
      run.clients[0]!.turns[1] = { ...run.clients[0]!.turns[1]!, tools: [{ name: "text_link", input: { text: "Кот" }, output: { ok: true, link } }] };
      expect(find(checkScenario(run), "no_invented_links", CLIENT_1).status).toBe("pass");
    });
  });

  it("finish_dialog не вызван — провал с причиной", () => {
    const run = scenarioRun({ clients: [clientRun({ turns: [consultantTurn()], endedBy: "reply_limit", clientReplies: 10 })] });
    const check = find(checkScenario(run), "finish_dialog", CLIENT_1);
    expect(check.status).toBe("fail");
    expect(check.details).toMatch(/10 реплик/);
  });

  it("клиент попрощался, а консультант не завершил — своя причина", () => {
    const run = scenarioRun({ clients: [clientRun({ turns: [consultantTurn()], endedBy: "client_left" })] });
    expect(find(checkScenario(run), "finish_dialog", CLIENT_1).details).toMatch(/попрощался/);
  });

  it("клиент ушёл посреди разговора, не прощаясь, — не провал консультанта", () => {
    const run = scenarioRun({ clients: [clientRun({ turns: [consultantTurn()], endedBy: "client_left", leftMidConversation: true })] });
    const check = find(checkScenario(run), "finish_dialog", CLIENT_1);
    expect(check.status).toBe("skip");
    expect(check.details).toMatch(/посреди разговора/);
  });

  it("вопрос в тексте модели, который человеку не ушёл, — не провал", () => {
    const finishing = consultantTurn({ finished: true, textAfterFinish: "Записал! Есть ещё вопросы?", bot: ["Спасибо за разговор!"], tools: [{ name: "finish_dialog", input: { outcome: "agreed" } }] });
    const run = scenarioRun({ clients: [clientRun({ turns: [consultantTurn(), finishing] })] });
    expect(find(checkScenario(run), "no_text_after_finish", CLIENT_1).status).toBe("pass");
  });

  it("вопрос после finish_dialog и сообщения после завершения — провал", () => {
    const finishing = consultantTurn({ finished: true, textAfterFinish: "Готово! А что ещё вас волнует?", bot: ["Готово! А что ещё вас волнует?"], tools: [{ name: "finish_dialog", input: {} }] });
    const late = consultantTurn({ client: "Спасибо" });
    const run = scenarioRun({ clients: [clientRun({ turns: [consultantTurn(), finishing, late] })] });
    const check = find(checkScenario(run), "no_text_after_finish", CLIENT_1);
    expect(check.status).toBe("fail");
    expect(check.details).toContain("вопрос");
    expect(check.details).toContain("после завершения");
  });

  it("ход без ответа или с двумя ответами — провал «одно сообщение на ход»", () => {
    const run = scenarioRun({
      clients: [clientRun({ turns: [consultantTurn(), consultantTurn({ consultantMessages: 0, bot: [] }), consultantTurn({ consultantMessages: 2 })] })],
    });
    const check = find(checkScenario(run), "one_message_per_turn", CLIENT_1);
    expect(check.status).toBe("fail");
    expect(check.details).toMatch(/ход 2.*0/);
    expect(check.details).toMatch(/ход 3.*2/);
  });

  it("нет ссылки на политику в первом сообщении — провал", () => {
    const run = scenarioRun({ clients: [clientRun({ turns: [consultantTurn({ client: "/start code", bot: ["Привет!"] })] })] });
    expect(find(checkScenario(run), "privacy_policy", CLIENT_1).status).toBe("fail");
  });

  it("согласился, а прощания из настроек нет — провал", () => {
    const finishing = consultantTurn({ finished: true, textAfterFinish: "Жду вас.", bot: ["Жду вас."], tools: [{ name: "finish_dialog", input: { outcome: "agreed" } }] });
    const run = scenarioRun({ clients: [clientRun({ turns: [consultantTurn(), finishing] })] });
    expect(find(checkScenario(run), "farewell", CLIENT_1).status).toBe("fail");
  });

  describe("при согласии до прощания из настроек — только ответ на вопрос", () => {
    const agreed = (bot: string[], answer?: string) =>
      scenarioRun({
        clients: [
          clientRun({
            turns: [
              consultantTurn(),
              consultantTurn({ finished: true, bot, tools: [{ name: "finish_dialog", input: { goal: "Г", stuckAt: "З", chosenStep: "Ш", outcome: "agreed", ...(answer ? { answer } : {}) } }] }),
            ],
          }),
        ],
      });
    const replyOf = (run: ReturnType<typeof scenarioRun>) => find(checkScenario(run), "agreed_reply", CLIENT_1);

    it("только прощание из настроек — норма", () => {
      expect(replyOf(agreed(["Спасибо за разговор!"])).status).toBe("pass");
    });

    it("ответ из поля answer перед прощанием — норма, одним сообщением или двумя", () => {
      const answer = "Эксперт напишет сам и уточнит время.";
      expect(replyOf(agreed([`${answer}\n\nСпасибо за разговор!`], answer)).status).toBe("pass");
      expect(replyOf(agreed([answer, "Спасибо за разговор!"], answer)).status).toBe("pass");
    });

    it("свой текст перед прощанием, которого нет в answer, — провал с цитатой", () => {
      const check = replyOf(agreed(["Хорошего дня, Павел — до вечера!\n\nСпасибо за разговор!"]));
      expect(check.status).toBe("fail");
      expect(check.details).toContain("до вечера");
    });

    it("ответ из answer длиннее 200 символов — провал", () => {
      const answer = "Эксперт свяжется и всё расскажет подробно. ".repeat(6).trim();
      const check = replyOf(agreed([`${answer}\n\nСпасибо за разговор!`], answer));
      expect(check.status).toBe("fail");
      expect(check.details).toMatch(/длинн/);
    });

    it("текст после прощания — провал", () => {
      expect(replyOf(agreed(["Спасибо за разговор!", "Ещё вопросы?"])).status).toBe("fail");
    });

    it("answer берётся из итога или из последнего удачного вызова, а не из отклонённого", () => {
      const answer = "Эксперт напишет сам и уточнит время.";
      const run = agreed([`${answer}\n\nСпасибо за разговор!`]);
      const client = run.clients[0]!;
      const finishing = client.turns.at(-1)!;
      finishing.tools = [
        { name: "finish_dialog", input: { outcome: "agreed", answer: "x".repeat(250) }, error: "answer: слишком длинно" },
        { name: "finish_dialog", input: { goal: "Г", stuckAt: "З", chosenStep: "Ш", outcome: "agreed", answer } },
      ];
      expect(replyOf(run).status).toBe("pass");
      finishing.tools = [];
      client.passage = { status: "completed", summary: { goal: "Г", stuckAt: "З", chosenStep: "Ш", outcome: "agreed", answer }, personMessageCount: 3, handoverReason: null };
      expect(replyOf(run).status).toBe("pass");
    });

    it("отказ или прощание не задано — проверка пропущена", () => {
      const declined = scenarioRun({
        clients: [clientRun({ passage: { status: "completed", summary: { goal: "Г", stuckAt: "З", chosenStep: "Ш", outcome: "declined" }, personMessageCount: 2, handoverReason: null } })],
      });
      expect(replyOf(declined).status).toBe("skip");
      const base = agreed(["Жду вас."]);
      expect(replyOf({ ...base, settings: { ...base.settings!, farewellMessage: "" } }).status).toBe("skip");
    });
  });

  it("заглушка вместо ответа в любой реплике бота — провал", () => {
    const placeholderIn = (bot: string[]) => find(checkScenario(scenarioRun({ clients: [clientRun({ turns: [consultantTurn(), consultantTurn({ bot }), ...clientRun().turns.slice(2)] })] })), "no_placeholder", CLIENT_1);
    expect(placeholderIn(["(пусто)\n\nСпасибо за разговор!"]).status).toBe("fail");
    expect(placeholderIn(["(ответ оставлен пустым)"]).details).toContain("(ответ оставлен пустым)");
    expect(placeholderIn(["[без ответа]"]).status).toBe("fail");
    expect(placeholderIn(["Пусто в зале по утрам (почти никого), приходите."]).status).toBe("pass");
  });

  describe("прощание при отказе и уходе", () => {
    const ended = (outcome: "declined" | "left", textAfterFinish: string | null, bot: string[]) =>
      scenarioRun({
        clients: [
          clientRun({
            turns: [
              consultantTurn(),
              consultantTurn({ finished: true, textAfterFinish, bot, tools: [{ name: "finish_dialog", input: { goal: "Г", stuckAt: "З", chosenStep: "Ш", outcome } }] }),
            ],
            passage: { status: "completed", summary: { goal: "Г", stuckAt: "З", chosenStep: "Ш", outcome }, personMessageCount: 2, handoverReason: null },
          }),
        ],
      });
    const farewellOf = (run: ReturnType<typeof scenarioRun>) => find(checkScenario(run), "farewell", CLIENT_1);

    it("своё короткое прощание без прощания из настроек — норма", () => {
      expect(farewellOf(ended("declined", "Понял вас, всего доброго!", ["Понял вас, всего доброго!"])).status).toBe("pass");
      expect(farewellOf(ended("left", "Хорошего дня!", ["Хорошего дня!"])).status).toBe("pass");
    });

    it("прощание из настроек ушло — провал", () => {
      const check = farewellOf(ended("declined", "Всего доброго!", ["Всего доброго!\n\nСпасибо за разговор!"]));
      expect(check.status).toBe("fail");
      expect(check.details).toContain("Спасибо за разговор!");
    });

    it("«записал вас», длинное прощание или без прощания — провал", () => {
      expect(farewellOf(ended("left", "Записал вас, до встречи!", ["Записал вас, до встречи!"])).details).toMatch(/записал/i);
      const long = `Хорошо. ${"Очень жаль, что так вышло, но я всё понимаю. ".repeat(6)}`;
      expect(farewellOf(ended("declined", long, [long])).details).toMatch(/длинн/);
      expect(farewellOf(ended("left", null, [])).details).toMatch(/не попрощался/);
    });
  });

  it("итог без исхода — провал прощания и итога", () => {
    const base = clientRun();
    const run = scenarioRun({ clients: [clientRun({ passage: { ...base.passage!, summary: { goal: "Г", stuckAt: "З", chosenStep: "Ш" } }, turns: base.turns.map((turn) => (turn.finished ? { ...turn, tools: [{ name: "finish_dialog", input: {} }] } : turn)) })] });
    const checks = checkScenario(run);
    expect(find(checks, "summary_complete", CLIENT_1).details).toContain("outcome");
    expect(find(checks, "farewell", CLIENT_1).status).toBe("fail");
  });

  it("предел сообщений без finish_dialog: прощание из настроек не уходит", () => {
    const limited = (bot: string[]) =>
      scenarioRun({
        clients: [clientRun({ turns: [consultantTurn(), consultantTurn({ bot })], endedBy: "message_limit", passage: { status: "not_completed", summary: null, personMessageCount: 2, handoverReason: null } })],
      });
    expect(find(checkScenario(limited(["Понял, спасибо."])), "farewell", CLIENT_1).status).toBe("pass");
    expect(find(checkScenario(limited(["Понял.\n\nСпасибо за разговор!"])), "farewell", CLIENT_1).status).toBe("fail");
  });

  it("два ролика за ответ — провал", () => {
    const show = { name: "show_video", input: { id: "x" } };
    const run = scenarioRun({ clients: [clientRun({ turns: [consultantTurn({ tools: [show, show] })] })] });
    expect(find(checkScenario(run), "one_video_per_reply", CLIENT_1).status).toBe("fail");
  });

  it("разметка в сообщениях клиенту и в ответах конструктора — провал", () => {
    const base = scenarioRun();
    const run = scenarioRun({
      building: { ...base.building, turns: [{ ...base.building.turns[0]!, reply: "## Итог\n| поле | значение |\n|---|---|" }] },
      clients: [clientRun({ turns: [consultantTurn({ bot: ["**Шаг 1.** Сделайте так"] })] })],
    });
    const checks = checkScenario(run);
    expect(find(checks, "plain_text", CLIENT_1).status).toBe("fail");
    expect(find(checks, "constructor_plain_text").status).toBe("fail");
  });

  describe("конструктор пишет без списков и жирного", () => {
    const base = scenarioRun();
    const plainText = (reply: string) =>
      find(checkScenario(scenarioRun({ building: { ...base.building, turns: [{ ...base.building.turns[0]!, reply }] } })), "constructor_plain_text").status;

    it("список из двух и больше пунктов — провал: маркеры, звёздочки, точки и нумерация", () => {
      expect(plainText("Поменял:\n- первое сообщение\n- прощание")).toBe("fail");
      expect(plainText("Поменял:\n* первое сообщение\n* прощание\n* условие")).toBe("fail");
      expect(plainText("Вопросы:\n1. Где звонок?\n2. Кто подтверждает время?")).toBe("fail");
      expect(plainText("Вопросы:\n1) Где звонок?\n2) Кто подтверждает время?")).toBe("fail");
      expect(plainText("Вопросы:\n- имя\n- возраст\n- город\n- работа\n- цель")).toBe("fail");
    });

    it("жирный в пункте и жирный заголовок — провал", () => {
      expect(plainText("Добавил поле:\n- **Имя** — как обращаться")).toBe("fail");
      expect(plainText("**Что поменял:** первое сообщение и прощание")).toBe("fail");
      expect(plainText("__Что поменял__ — первое сообщение")).toBe("fail");
    });

    it("один пункт, тире в середине фразы и обычный текст — норма", () => {
      expect(plainText("Поменял первое сообщение — теперь короче, и прощание тоже.")).toBe("pass");
      expect(plainText("Вот что вышло:\n- первое сообщение стало короче")).toBe("pass");
      expect(plainText("Сначала первое сообщение.\n\nПотом прощание.\n\nВ 2026 году. 3 вопроса осталось.")).toBe("pass");
    });
  });

  it("итог без пункта — провал", () => {
    const run = scenarioRun({ clients: [clientRun({ passage: { ...clientRun().passage!, summary: { goal: "Г", stuckAt: "", chosenStep: "Ш" } } })] });
    expect(find(checkScenario(run), "summary_complete", CLIENT_1).status).toBe("fail");
  });
});

describe("checkScenario: программа на несколько дней", () => {
  const PROGRAM_CHECKS = ["program_no_night_outreach", "program_outreach_per_day", "program_sale_not_early", "program_hard_frame", "program_no_sales_cliches", "flow_morning_single"];
  const CLIENT = "клиент 1: Сомневающаяся Марина";
  const check = (turns: Parameters<typeof programClient>[0], id: string, overrides: Parameters<typeof programClient>[1] = {}) =>
    find(checkScenario(programRun([programClient(turns, overrides)])), id, CLIENT);
  const path = (...steps: FlowTransitionRecord[]) => ({ flow: { transitions: [flowStart(), ...steps], endReason: "deadline" } });

  /** Три дня: день 1 разговор и касания, утром — одно сообщение, «Продажа» в день 3 по сроку ноды. */
  const goodDays = () => [
    said("Хочу игру про кота", 1, "12:01"),
    silent("до завтра", 2, "09:00", [
      ["outreach", 1, "12:16", "Кстати, кота можно нарисовать в шляпе."],
      ["outreach", 1, "13:01", "Вот пример запроса для агента: …"],
      ["outreach", 1, "16:01", "Ещё идея: звук мяу по нажатию."],
      ["outreach", 2, "09:00", "Доброе утро! Сегодня соберём первую версию."],
    ]),
    said("Собрал!", 2, "10:05"),
    silent("до завтра", 3, "09:00", [["outreach", 3, "09:00", "Доброе утро! Покажу, что можно сделать дальше."]]),
  ];

  it("без «Дней и времени» проверок программы нет", () => {
    const ids = checkScenario(scenarioRun()).map((entry) => entry.id);
    for (const id of PROGRAM_CHECKS) expect(ids).not.toContain(id);
  });

  it("правильные три дня проходят все проверки", () => {
    const failed = checkScenario(programRun([programClient(goodDays())])).filter((entry) => entry.status === "fail");
    expect(failed).toEqual([]);
  });

  it("проверки читают сценарий: старых этапов и программы в настройках нет", () => {
    const run = programRun([programClient(goodDays())]);
    expect(run.settings!.stages).toEqual([]);
    expect(run.settings!.program).toBeNull();
    const ids = checkScenario(run).map((entry) => entry.id);
    for (const id of PROGRAM_CHECKS) expect(ids).toContain(id);
    expect(find(checkScenario(run), "program_sale_not_early", CLIENT).status).toBe("pass");
  });

  it("сообщение первым ночью (с 21:00 до 9:00 по сценарию) — провал; ответ на сообщение человека ночью — можно", () => {
    const night = check(
      [
        said("Не сплю, вопрос", 1, "23:10", [["consultant", 1, "23:10", "Отвечаю."]]),
        silent("до завтра", 2, "09:30", [
          ["outreach", 1, "21:30", "Вечерняя идея"],
          ["outreach", 2, "08:30", "Ранняя идея"],
        ]),
      ],
      "program_no_night_outreach",
    );
    expect(night.status).toBe("fail");
    expect(night.details).toContain("21:30");
    expect(night.details).toContain("08:30");
    expect(night.details).not.toContain("23:10");
    expect(night.title).toContain("21:00");
    expect(check([silent("до завтра", 2, "10:00", [["outreach", 1, "20:59", "Ещё вечер"]])], "program_no_night_outreach").status).toBe("pass");
    expect(check([silent("до завтра", 2, "10:00", [["outreach", 1, "21:00", "Уже ночь"]])], "program_no_night_outreach").status).toBe("fail");
  });

  it("четыре сообщения первым за день — провал, три — можно", () => {
    const four = check(
      [
        silent("до завтра", 3, "10:00", [
          ["outreach", 2, "10:00", "1"],
          ["outreach", 2, "13:00", "2"],
          ["outreach", 2, "16:00", "3"],
          ["outreach", 2, "19:00", "4"],
        ]),
      ],
      "program_outreach_per_day",
    );
    expect(four.status).toBe("fail");
    expect(four.details).toContain("день 2: 4");
    expect(check(goodDays(), "program_outreach_per_day").status).toBe("pass");
  });

  it("«Продажа» раньше своего дня: заявка или судья с причиной — можно, без причины или по сроку — провал", () => {
    const withReason = check(goodDays(), "program_sale_not_early", path(transition({ decidedBy: "judge", day: 2, reason: "Прислал ссылку на опубликованное приложение" })));
    expect(withReason.status).toBe("pass");
    expect(withReason.details).toContain("Прислал ссылку");

    const noReason = check(goodDays(), "program_sale_not_early", path(transition({ decidedBy: "claim", day: 2, reason: " " })));
    expect(noReason.status).toBe("fail");
    expect(noReason.details).toContain("день 2");

    expect(check(goodDays(), "program_sale_not_early", path(transition({ decidedBy: "timer", day: 1, reason: "нода длится 1 день" }))).status).toBe("fail");
    expect(check(goodDays(), "program_sale_not_early", path(transition({ decidedBy: "timer", day: 3 }))).status).toBe("pass");
    expect(check(goodDays(), "program_sale_not_early", path()).details).toContain("не дошли");
  });

  it("день «Продажи» — по сроку нод от старта; нет ноды с меткой «продажа» — проверка пропущена", () => {
    const run = programRun([programClient(goodDays(), path(transition({ decidedBy: "judge", day: 2, reason: "Загорелся" })))]);
    expect(find(checkScenario(run), "program_sale_not_early", CLIENT).title).toContain("день 3");
    run.settings!.flow.states.forEach((state) => (state.tags = []));
    expect(find(checkScenario(run), "program_sale_not_early", CLIENT).status).toBe("skip");
  });

  it("жёсткая рамка (3-е сообщение за день): одна фраза «Утром отвечу!», дальше тишина до утра", () => {
    // Рамка — 3: второе получает прощание на сегодня, третье — фразу рамки, четвёртое — ничего; утром ответ на всё
    const frame = [
      said("1", 1, "20:00"),
      said("2", 1, "20:01", [["consultant", 1, "20:01", "Продолжим утром!"]]),
      said("3", 1, "20:02", [["day_closed", 1, "20:02", "Утром отвечу!"]]),
      said("4", 1, "20:03", []),
    ];
    const morning = silent("до завтра", 2, "09:00", [["outreach", 2, "09:00", "Доброе утро! Отвечаю на вчерашнее."]]);
    expect(check([...frame, morning], "program_hard_frame").status).toBe("pass");

    const answered = check([...frame.slice(0, 3), said("4", 1, "20:03", [["consultant", 1, "20:03", "Ещё отвечу"]]), morning], "program_hard_frame");
    expect(answered.status).toBe("fail");
    expect(answered.details).toContain("Ещё отвечу");

    const outreachAfter = check([...frame, silent("до завтра", 2, "10:00", [["outreach", 1, "20:30", "Идея на вечер"]])], "program_hard_frame");
    expect(outreachAfter.status).toBe("fail");

    const twoStubs = check([...frame.slice(0, 3), said("4", 1, "20:03", [["day_closed", 1, "20:03", "Утром отвечу!"]])], "program_hard_frame");
    expect(twoStubs.status).toBe("fail");

    const noStub = check([...frame.slice(0, 2), said("3", 1, "20:02", []), morning], "program_hard_frame");
    expect(noStub.status).toBe("fail");
    expect(noStub.details).toContain("фраз");
  });

  it("рамку дня не прошли — проверка пропущена", () => {
    expect(check(goodDays(), "program_hard_frame").status).toBe("skip");
  });

  it("штамп продаж в ответе или сообщении первым — провал с названием штампа", () => {
    const cliche = check(
      [said("Дорого", 3, "11:00", [["consultant", 3, "11:00", "Понимаю. Дорого — это сколько?"]]), silent("3 ч", 3, "14:00", [["outreach", 3, "14:00", "Не упустите шанс!"]])],
      "program_no_sales_cliches",
    );
    expect(cliche.status).toBe("fail");
    expect(cliche.details).toContain("дорого — это сколько");
    expect(cliche.details).toContain("не упустите шанс");
    expect(check(goodDays(), "program_no_sales_cliches").status).toBe("pass");
  });

  it("ссылка из инструкции ноды — не выдуманная", () => {
    const run = programRun([programClient([said("Где урок?", 3, "11:00", [["consultant", 3, "11:00", "Вот урок: https://pay.example.com/urok"]])])]);
    run.settings!.flow.states.find((state) => state.id === "sale")!.instructions = "Предложи интенсив. Бесплатный урок: https://pay.example.com/urok";
    expect(find(checkScenario(run), "no_invented_links", CLIENT).status).toBe("pass");
  });

  it("срок вышел без finish_dialog — не провал завершения", () => {
    expect(check(goodDays(), "finish_dialog").status).toBe("skip");
  });

  it("одно сообщение на ход: молчание и сообщения с рамки дня не считаются", () => {
    const turns = [
      said("1", 1, "20:00"),
      said("2", 1, "20:01"),
      said("3", 1, "20:02", [["day_closed", 1, "20:02", "Утром отвечу!"]]),
      said("4", 1, "20:03", []),
      silent("до завтра", 2, "10:00", [["outreach", 2, "09:00", "Доброе утро!"], ["outreach", 2, "13:00", "Идея"]]),
    ];
    expect(check(turns, "one_message_per_turn").status).toBe("pass");
    const silentReply = check([said("Привет", 2, "11:00", [])], "one_message_per_turn");
    expect(silentReply.status).toBe("fail");
  });

  it("утром одно сообщение на все причины: два в начале дня — провал, одно — можно", () => {
    expect(check(goodDays(), "flow_morning_single").status).toBe("pass");
    const twice = check(
      [
        said("Хочу игру", 1, "12:01"),
        silent("до завтра", 2, "09:30", [
          ["outreach", 2, "09:00", "Доброе утро!"],
          ["outreach", 2, "09:00", "Кстати, вчера вы спрашивали…"],
        ]),
      ],
      "flow_morning_single",
    );
    expect(twice.status).toBe("fail");
    expect(twice.details).toContain("день 2");
    expect(check([said("Хочу игру", 1, "12:01")], "flow_morning_single").status).toBe("pass");
  });
});

describe("checkScenario: переходы и расход сценария", () => {
  const CLIENT = "клиент 1: Сомневающаяся Марина";
  const run = (client: Partial<ClientRun>) => programRun([programClient([said("Хочу игру", 1, "12:01")], client)]);

  it("у каждого перехода есть причина; начало сценария не переход", () => {
    expect(find(checkScenario(run({})), "flow_transition_reason", CLIENT).status).toBe("pass");
    const silent = find(
      checkScenario(run({ flow: { transitions: [flowStart(), transition({ decidedBy: "judge", day: 2, reason: "" }), transition({ to: "final", title: "Итог", from: "sale", decidedBy: "event", reason: null })], endReason: "final" } })),
      "flow_transition_reason",
      CLIENT,
    );
    expect(silent.status).toBe("fail");
    expect(silent.details).toContain("«Идея» → «Продажа»");
    expect(silent.details).toContain("judge");
    expect(silent.details).toContain("«Продажа» → «Итог»");
    expect(find(checkScenario(scenarioRun()), "flow_transition_reason", CLIENT).status).toBe("skip");
  });

  it("судья — не больше 10 % цены ходов консультанта", () => {
    const usage = (judgeUsd: number) => ({ answerUsd: 0.008, firstMessageUsd: 0.0015, correctionUsd: 0.0005, judgeUsd });
    const cheap = find(checkScenario(run({ usage: usage(0.0002) })), "flow_judge_share", CLIENT);
    expect(cheap.status).toBe("pass");
    expect(cheap.details).toContain("2 %");
    const dear = find(checkScenario(run({ usage: usage(0.002) })), "flow_judge_share", CLIENT);
    expect(dear.status).toBe("fail");
    expect(dear.details).toContain("20 %");
    expect(find(checkScenario(run({})), "flow_judge_share", CLIENT).status).toBe("skip");
    expect(find(checkScenario(run({ usage: { answerUsd: 0, firstMessageUsd: 0, correctionUsd: 0, judgeUsd: 0 } })), "flow_judge_share", CLIENT).status).toBe("skip");
  });
});

describe("checkScenario: касания и «не завершил» без «Дней и времени»", () => {
  const CLIENT = "клиент 1: Сомневающаяся Марина";
  const left = (tail: ConsultantTurn, overrides: Partial<ClientRun> = {}) =>
    scenarioRun({
      clients: [
        clientRun({
          turns: [...clientRun().turns.slice(0, 2), tail],
          endedBy: "client_left",
          passage: { status: "not_completed", summary: null, personMessageCount: 2, handoverReason: null },
          flow: { transitions: [{ ...flowStart(), to: "conversation", title: "Разговор" }], endReason: "abandoned" },
          ...overrides,
        }),
      ],
    });
  const touches = () =>
    plainSilent(SILENCE_TILL_END, 4, "12:05", [
      ["outreach", 1, "12:20", "Вы тут? Можем продолжить с того места."],
      ["outreach", 1, "13:20", "Подскажу первый шаг, если интересно."],
      ["outreach", 2, "10:00", "Доброе утро! Вернёмся к пробному занятию?"],
    ]);

  it("молчал после разговора: касания были, через 3 дня — «не завершил»", () => {
    const check = find(checkScenario(left(touches())), "flow_abandoned", CLIENT);
    expect(check.status).toBe("pass");
    expect(check.details).toContain("касаний: 3");
    expect(check.details).toContain("12:20");
  });

  it("разговор не закончился или кончился не тишиной — провал", () => {
    const active = find(checkScenario(left(touches(), { passage: { status: "active", summary: null, personMessageCount: 2, handoverReason: null }, flow: { transitions: [], endReason: null } })), "flow_abandoned", CLIENT);
    expect(active.status).toBe("fail");
    expect(active.details).toContain("active");
  });

  it("касаний не было — провал", () => {
    const check = find(checkScenario(left(plainSilent(SILENCE_TILL_END, 4, "12:05"))), "flow_abandoned", CLIENT);
    expect(check.status).toBe("fail");
    expect(check.details).toContain("касаний не было");
  });

  it("консультант завершил разговор или у сценария нет «не завершил» — пропуск", () => {
    expect(find(checkScenario(scenarioRun()), "flow_abandoned", CLIENT).status).toBe("skip");
    expect(find(checkScenario(programRun([programClient([said("Хочу игру", 1, "12:01")])])), "flow_abandoned", CLIENT).status).toBe("skip");
  });

  it("касания по правилам приложения: ночь с 22:00 до 9:00 и не больше 3 в день", () => {
    const run = left(
      plainSilent(SILENCE_TILL_END, 4, "12:05", [
        ["outreach", 1, "21:59", "Ещё вечер"],
        ["outreach", 1, "22:30", "Ночное"],
        ["outreach", 2, "09:00", "1"],
        ["outreach", 2, "12:00", "2"],
        ["outreach", 2, "15:00", "3"],
        ["outreach", 2, "19:00", "4"],
      ]),
    );
    const night = find(checkScenario(run), "nudges_no_night", CLIENT);
    expect(night.status).toBe("fail");
    expect(night.details).toContain("22:30");
    expect(night.details).not.toContain("21:59");
    const perDay = find(checkScenario(run), "nudges_per_day", CLIENT);
    expect(perDay.status).toBe("fail");
    expect(perDay.details).toContain("2026-10-12: 4");
    expect(find(checkScenario(left(touches())), "nudges_per_day", CLIENT).status).toBe("pass");
    expect(find(checkScenario(left(touches())), "nudges_no_night", CLIENT).status).toBe("pass");
  });
});
