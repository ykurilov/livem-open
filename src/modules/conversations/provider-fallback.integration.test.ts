// Кончились деньги у основного провайдера: ход уходит к запасному, владелец узнаёт об этом тревогой
import { randomUUID } from "node:crypto";
import { extendCatalog } from "@ykurilov/agent-chat-core";
import { APICallError } from "ai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, DEFAULT_CONSULTANT_REPLY, defaultConsultantReply, isJudgeCall } from "../../../tests/integration/live-dialog-kit";
import { createAppCatalog, DEFAULT_MODEL_CHOICE } from "../platform/models-catalog";
import { createScriptedModel } from "../platform/scripted-model";
import { updateSettings } from "../platform/settings";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await updateSettings(database.db, { alertChatId: "777" });
});

afterAll(async () => {
  await database.drop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Пустой счёт DeepSeek, каким его отдаёт API: 402 «Insufficient Balance». */
const insufficientBalance = () =>
  new APICallError({
    message: "Insufficient Balance",
    url: "https://api.deepseek.test/chat/completions",
    requestBodyValues: {},
    statusCode: 402,
    responseBody: JSON.stringify({ error: { message: "Insufficient Balance", type: "unknown_error" } }),
    isRetryable: false,
  });

/** Модель лидмагнитов по умолчанию у подставных провайдеров: DeepSeek без денег, Together отвечает, OpenRouter — второй запасной. */
function catalogWithEmptyDeepSeek() {
  const deepseek = createScriptedModel(() => {
    throw insufficientBalance();
  });
  const answering = () => createScriptedModel((call) => (isJudgeCall(call) ? { text: JSON.stringify({ met: [] }) } : defaultConsultantReply(call)));
  const together = answering();
  const openrouter = answering();
  const provider = (id: string, model: typeof deepseek.model) => ({
    id,
    displayName: id,
    apiKeyEnv: `${id.toUpperCase()}_API_KEY`,
    createLanguageModel: () => model,
    requestOptions: () => ({}),
  });
  const catalog = extendCatalog(createAppCatalog({}), {
    removeModels: [DEFAULT_MODEL_CHOICE.modelId],
    removeProviders: ["deepseek", "together", "openrouter"],
    addProviders: [provider("deepseek", deepseek.model), provider("together", together.model), provider("openrouter", openrouter.model)],
    addModels: [
      {
        id: DEFAULT_MODEL_CHOICE.modelId,
        displayName: "DeepSeek 4.1 Flash",
        contextWindowTokens: 100_000,
        acceptsImages: false,
        reasoning: { replayPastTurns: true },
        providerModelIds: { deepseek: "deepseek-flash", together: "deepseek-ai/DeepSeek-V4.1-Flash", openrouter: "deepseek/deepseek-v4.1-flash" },
        pricing: {
          deepseek: { inputPerMillion: 0, outputPerMillion: 0 },
          together: { inputPerMillion: 0, outputPerMillion: 0 },
          openrouter: { inputPerMillion: 0, outputPerMillion: 0 },
        },
      },
    ],
  });
  return { catalog, deepseek, together, openrouter };
}

describe("запасной провайдер", () => {
  it("402 у DeepSeek — ход уходит на Together, OpenRouter не трогается, человек получает ответ, в журнале и тревоге — [ВНИМАНИЕ провайдер]", async () => {
    const logged: string[] = [];
    for (const method of ["error", "warn", "log"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    const models = catalogWithEmptyDeepSeek();
    const kit = await createLiveDialogKit(database, {
      realModel: { catalog: models.catalog, choice: DEFAULT_MODEL_CHOICE, env: { DEEPSEEK_API_KEY: "test", TOGETHER_API_KEY: "test", OPENROUTER_API_KEY: "test" } },
    });
    const person = `user-${randomUUID().slice(0, 8)}`;
    const lead = await kit.publish();
    await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
    await kit.drain();

    await kit.send(person, "Я дизайнер");
    await kit.drain();

    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
    expect(models.deepseek.calls.length).toBeGreaterThan(0);
    expect(models.together.calls.filter((call) => call.lastUserText.includes("Я дизайнер"))).toHaveLength(1);
    expect(models.openrouter.calls).toHaveLength(0);
    expect(logged).toContainEqual(expect.stringContaining("[ВНИМАНИЕ провайдер] deepseek: кончились деньги — ходы идут через запасной together"));
    expect(kit.alertTexts).toContainEqual(expect.stringContaining("deepseek: кончились деньги — ходы идут через запасной together"));
    const passage = (await kit.passagesOf(person))[0]!;
    expect(passage).toMatchObject({ handedToExpertAt: null, turnFailures: 0 });
  });
});
