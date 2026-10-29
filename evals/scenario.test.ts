import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { leadMagnetInput, loadScenarios, loadScenarioSet, parseScenario } from "./scenario";

const VALID = `---
id: normal-yoga
kind: normal
set: growth
title: Йога для офиса
expertReplies: 12
clientReplies: 10
---

# Эксперт

Анна, тренер по йоге. Пишет коротко.

## Цель

Собрать лидмагнит, который приведёт на пробное занятие.

# Клиент: Сомневающаяся Марина

Марина, 34 года, бухгалтер. Сомневается во всём.

# Клиент: Односложный Олег

Олег отвечает одним словом.
`;

describe("parseScenario", () => {
  it("читает frontmatter, эксперта, цель и двух клиентов", () => {
    const scenario = parseScenario(VALID, "normal-yoga.md");
    expect(scenario).toEqual({
      id: "normal-yoga",
      kind: "normal",
      set: "growth",
      title: "Йога для офиса",
      expertReplies: 12,
      clientReplies: 10,
      expert: {
        card: "Анна, тренер по йоге. Пишет коротко.",
        goal: "Собрать лидмагнит, который приведёт на пробное занятие.",
      },
      clients: [
        { name: "Сомневающаяся Марина", card: "Марина, 34 года, бухгалтер. Сомневается во всём." },
        { name: "Односложный Олег", card: "Олег отвечает одним словом." },
      ],
    });
  });

  it("ссылка эксперта (expertLink) — необязательное поле: адрес, который бот должен дать клиенту", () => {
    const withLink = VALID.replace("clientReplies: 10\n", "clientReplies: 10\nexpertLink: https://yoga-anna.ru/probnoe\n");
    expect(parseScenario(withLink, "normal-yoga.md").expertLink).toBe("https://yoga-anna.ru/probnoe");
    expect(() => parseScenario(VALID.replace("clientReplies: 10\n", "clientReplies: 10\nexpertLink: не адрес\n"), "normal-yoga.md")).toThrow(/expertLink/);
  });

  it("id должен совпадать с именем файла", () => {
    expect(() => parseScenario(VALID, "other.md")).toThrow(/other\.md.*normal-yoga/);
  });

  it("без цели эксперта — понятная ошибка с именем файла", () => {
    expect(() => parseScenario(VALID.replace("## Цель", "## Что-то"), "normal-yoga.md")).toThrow(/normal-yoga\.md.*Цель/);
  });

  it("неизвестный вид сценария — ошибка", () => {
    expect(() => parseScenario(VALID.replace("kind: normal", "kind: weird"), "normal-yoga.md")).toThrow(/normal-yoga\.md/);
  });

  it("без клиентов — ошибка", () => {
    const withoutClients = VALID.slice(0, VALID.indexOf("# Клиент"));
    expect(() => parseScenario(withoutClients, "normal-yoga.md")).toThrow(/клиент/i);
  });
});

const PROGRAM = `---
id: program-app
kind: program
set: growth
title: Первое приложение за 3 дня
clientReplies: 30
days: 3
leadMagnet: docs/lead-magnets/app.json
---

# Эксперт

Дмитрий, автор сервиса.

## Цель

Довести до приложения и продать интенсив.

# Лидмагнит

Поверх файла: программа и этап «Продажа».

\`\`\`json
{
  "program": { "softDailyMessages": 8, "hardDailyMessages": 12 },
  "stages": [
    { "name": "Сборка", "transitionCondition": "Собрал и опубликовал" },
    { "name": "Продажа", "instruction": "Предложи интенсив", "transitionCondition": "", "startDay": 3, "isSale": true }
  ],
  "endCondition": "Сказал «да» интенсиву"
}
\`\`\`

# Клиент: Молчун Игорь

Старт: 19:30
Игорь отвечает раз в день.
`;

describe("parseScenario: программа на несколько дней", () => {
  it("читает срок, файл лидмагнита с правкой поверх и время старта клиента; реплики эксперта не нужны", () => {
    const scenario = parseScenario(PROGRAM, "program-app.md");
    expect(scenario.kind).toBe("program");
    expect(scenario.days).toBe(3);
    expect(scenario.expertReplies).toBeUndefined();
    expect(scenario.leadMagnet?.file).toBe("docs/lead-magnets/app.json");
    expect(scenario.leadMagnet?.overlay).toMatchObject({ endCondition: "Сказал «да» интенсиву", program: { hardDailyMessages: 12 } });
    expect(scenario.clients).toEqual([{ name: "Молчун Игорь", card: "Игорь отвечает раз в день.", startsAt: "19:30" }]);
  });

  it("строка «Профиль:» — имя клиента в профиле мессенджера, рядом со «Старт:» в любом порядке", () => {
    const scenario = parseScenario(PROGRAM.replace("Старт: 19:30\n", "Профиль: igor_sklad\nСтарт: 19:30\n"), "program-app.md");
    expect(scenario.clients).toEqual([{ name: "Молчун Игорь", card: "Игорь отвечает раз в день.", startsAt: "19:30", profileName: "igor_sklad" }]);
  });

  it("без файла лидмагнита реплики эксперта обязательны: лидмагнит собирает конструктор", () => {
    expect(() => parseScenario(PROGRAM.replace("leadMagnet: docs/lead-magnets/app.json\n", ""), "program-app.md")).toThrow(/expertReplies/);
  });

  it("правка лидмагнита — JSON-объект, иначе понятная ошибка", () => {
    expect(() => parseScenario(PROGRAM.replace('"endCondition": "Сказал «да» интенсиву"', "сломано"), "program-app.md")).toThrow(/program-app\.md.*JSON/);
  });

  it("лидмагнит из файла: правка поверх, этапы по названию дополняются, новые — в конец, срок программы из сценария", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-lead-magnet-"));
    await writeFile(
      path.join(dir, "app.json"),
      JSON.stringify({
        name: "Первое приложение",
        endCondition: "Опубликовал",
        stages: [
          { name: "Идея", instruction: "Выбери", transitionCondition: "Выбрал" },
          { name: "Сборка", instruction: "Собери", transitionCondition: "Собрал" },
        ],
      }),
    );
    const scenario = parseScenario(PROGRAM.replace("docs/lead-magnets/app.json", "app.json"), "program-app.md");
    expect(await leadMagnetInput(scenario, dir)).toEqual({
      name: "Первое приложение",
      endCondition: "Сказал «да» интенсиву",
      stages: [
        { name: "Идея", instruction: "Выбери", transitionCondition: "Выбрал" },
        { name: "Сборка", instruction: "Собери", transitionCondition: "Собрал и опубликовал" },
        { name: "Продажа", instruction: "Предложи интенсив", transitionCondition: "", startDay: 3, isSale: true },
      ],
      program: { days: 3, softDailyMessages: 8, hardDailyMessages: 12 },
    });
  });
});

describe("программа из файла лидмагнита", () => {
  it("сценарий без правки программы оставляет программу файла целиком; срок и ключи правки — поверх", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-lead-magnet-"));
    const program = { days: 5, softDailyMessages: 20, hardDailyMessages: 30, sideTasks: [{ task: "Попросить отзыв", field: "Отзыв", when: "" }] };
    await writeFile(path.join(dir, "app.json"), JSON.stringify({ name: "Первое приложение", stages: [], program }));
    const bare = PROGRAM.replace("docs/lead-magnets/app.json", "app.json").replace(/# Лидмагнит[\s\S]*?```json[\s\S]*?```\n/, "");
    expect((await leadMagnetInput(parseScenario(bare, "program-app.md"), dir)).program).toEqual({ ...program, days: 3 });
    const patched = parseScenario(PROGRAM.replace("docs/lead-magnets/app.json", "app.json"), "program-app.md");
    expect((await leadMagnetInput(patched, dir)).program).toEqual({ ...program, days: 3, softDailyMessages: 8, hardDailyMessages: 12 });
  });
});

describe("сценарий из файла лидмагнита (flow)", () => {
  it("срок из сценария eval идёт в «Дни и время», правка поверх; старые этапы и программа в правке — ошибка", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-lead-magnet-"));
    const flow = { start: "a", states: [], schedule: { dayStart: "09:00", lengthDays: 5, farewellOnDeadline: true } };
    await writeFile(path.join(dir, "app.json"), JSON.stringify({ name: "Первое приложение", flow }));
    const bare = PROGRAM.replace("docs/lead-magnets/app.json", "app.json").replace(/# Лидмагнит[\s\S]*?```json[\s\S]*?```\n/, "");
    const input = await leadMagnetInput(parseScenario(bare, "program-app.md"), dir);
    expect(input).toEqual({ name: "Первое приложение", flow: { ...flow, schedule: { ...flow.schedule, lengthDays: 3 } } });
    expect(input).not.toHaveProperty("program");
    const patched = parseScenario(PROGRAM.replace("docs/lead-magnets/app.json", "app.json"), "program-app.md");
    await expect(leadMagnetInput(patched, dir)).rejects.toThrow(/flow/);
  });
});

describe("loadScenarios", () => {
  async function folderWith(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-scenarios-"));
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
    return dir;
  }

  it("читает все .md по алфавиту и пропускает остальное", async () => {
    const dir = await folderWith({
      "normal-yoga.md": VALID,
      "hard-a.md": VALID.replace("id: normal-yoga", "id: hard-a").replace("kind: normal", "kind: hard"),
      "README.txt": "не сценарий",
    });
    const scenarios = await loadScenarios(dir);
    expect(scenarios.map((scenario) => scenario.id)).toEqual(["hard-a", "normal-yoga"]);
  });

  it("с именем — только этот сценарий", async () => {
    const dir = await folderWith({ "normal-yoga.md": VALID, "hard-a.md": VALID.replace("id: normal-yoga", "id: hard-a") });
    expect((await loadScenarios(dir, "normal-yoga")).map((scenario) => scenario.id)).toEqual(["normal-yoga"]);
  });

  it("несколько имён через запятую — эти сценарии", async () => {
    const dir = await folderWith({ "normal-yoga.md": VALID, "hard-a.md": VALID.replace("id: normal-yoga", "id: hard-a"), "hard-b.md": VALID.replace("id: normal-yoga", "id: hard-b") });
    expect((await loadScenarios(dir, "normal-yoga, hard-b")).map((scenario) => scenario.id)).toEqual(["hard-b", "normal-yoga"]);
    await expect(loadScenarios(dir, "normal-yoga,nope")).rejects.toThrow(/nope/);
  });

  it("неизвестное имя — ошибка со списком доступных", async () => {
    const dir = await folderWith({ "normal-yoga.md": VALID });
    await expect(loadScenarios(dir, "nope")).rejects.toThrow(/nope.*normal-yoga/);
  });
});

describe("набор сценария", () => {
  it("поле set обязательно и принимает growth, regression, holdout", () => {
    for (const set of ["growth", "regression", "holdout"]) expect(parseScenario(VALID.replace("set: growth", `set: ${set}`), "normal-yoga.md").set).toBe(set);
    expect(() => parseScenario(VALID.replace("set: growth\n", ""), "normal-yoga.md")).toThrow(/set/);
    expect(() => parseScenario(VALID.replace("set: growth", "set: other"), "normal-yoga.md")).toThrow(/set/);
  });
});

describe("loadScenarioSet", () => {
  const card = (id: string, set: string) => VALID.replace("id: normal-yoga", `id: ${id}`).replace("set: growth", `set: ${set}`);
  async function evalsDir(folders: Record<string, Record<string, string>>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "eval-sets-"));
    for (const [folder, files] of Object.entries(folders)) {
      await mkdir(path.join(root, folder));
      for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, folder, name), text);
    }
    return root;
  }
  const ids = async (promise: Promise<Array<{ id: string }>>) => (await promise).map((scenario) => scenario.id);

  it("без набора — «на рост» и «на поломки» из scenarios, отложенные не идут", async () => {
    const root = await evalsDir({
      scenarios: { "grow-a.md": card("grow-a", "growth"), "keep-b.md": card("keep-b", "regression") },
      "scenarios-holdout": { "hold-c.md": card("hold-c", "holdout") },
    });
    expect(await ids(loadScenarioSet(root))).toEqual(["grow-a", "keep-b"]);
  });

  it("growth и regression выбирают свой набор в scenarios", async () => {
    const root = await evalsDir({ scenarios: { "grow-a.md": card("grow-a", "growth"), "keep-b.md": card("keep-b", "regression") }, "scenarios-holdout": {} });
    expect(await ids(loadScenarioSet(root, "growth"))).toEqual(["grow-a"]);
    expect(await ids(loadScenarioSet(root, "regression"))).toEqual(["keep-b"]);
  });

  it("holdout читает только scenarios-holdout", async () => {
    const root = await evalsDir({ scenarios: { "grow-a.md": card("grow-a", "growth") }, "scenarios-holdout": { "hold-c.md": card("hold-c", "holdout") } });
    expect(await ids(loadScenarioSet(root, "holdout"))).toEqual(["hold-c"]);
  });

  it("--scenario сужает выбор внутри набора; сценарий из другого набора — ошибка", async () => {
    const root = await evalsDir({ scenarios: { "grow-a.md": card("grow-a", "growth"), "keep-b.md": card("keep-b", "regression") }, "scenarios-holdout": {} });
    expect(await ids(loadScenarioSet(root, undefined, "keep-b"))).toEqual(["keep-b"]);
    await expect(loadScenarioSet(root, "growth", "keep-b")).rejects.toThrow(/keep-b.*grow-a/);
  });

  it("сценарий не в той папке — ошибка: holdout в scenarios и не-holdout в scenarios-holdout", async () => {
    const misplaced = await evalsDir({ scenarios: { "hold-c.md": card("hold-c", "holdout") }, "scenarios-holdout": {} });
    await expect(loadScenarioSet(misplaced)).rejects.toThrow(/hold-c.*scenarios-holdout/);
    const wrongWay = await evalsDir({ scenarios: {}, "scenarios-holdout": { "grow-a.md": card("grow-a", "growth") } });
    await expect(loadScenarioSet(wrongWay, "holdout")).rejects.toThrow(/grow-a.*holdout/);
  });
});

describe("сценарии проекта", () => {
  const evalsDir = path.join(process.cwd(), "evals");
  // Отложенных сценариев нет в открытой копии: у каждой установки свои
  const hasHoldout = existsSync(path.join(evalsDir, "scenarios-holdout"));

  it("каждый лежит в папке своего набора, id не повторяются", async () => {
    const holdout = hasHoldout ? await loadScenarioSet(evalsDir, "holdout") : [];
    const all = [...(await loadScenarioSet(evalsDir, "growth")), ...(await loadScenarioSet(evalsDir, "regression")), ...holdout];
    const ids = all.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect((await loadScenarioSet(evalsDir)).every((scenario) => scenario.set !== "holdout")).toBe(true);
  });

  it.skipIf(!hasHoldout)("отложенных четыре: есть normal, hard и provocateur", async () => {
    const holdout = await loadScenarioSet(evalsDir, "holdout");
    expect(holdout).toHaveLength(4);
    expect(new Set(holdout.map((scenario) => scenario.kind))).toEqual(new Set(["normal", "hard", "provocateur"]));
  });
});
