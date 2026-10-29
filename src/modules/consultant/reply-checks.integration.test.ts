import { createInMemoryChatStorage, type ChatStorage } from "@ykurilov/agent-chat-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLeadMagnet, getLeadMagnet, saveDraft, type LeadMagnet } from "../lead-magnets";
import { STUB_MODEL_CHOICE, createAppCatalog, createStubModelCatalog } from "../platform/models-catalog";
import { createScriptedModel, type ScriptedCall, type ScriptedReply } from "../platform/scripted-model";
import { createVideo } from "../videos";
import { createPreviewEndpoint, type PreviewEndpoint } from "./preview-endpoint";

/**
 * Сквозная проверка ответа консультанта: настоящая служба SDK, подставная модель, хранилище в памяти.
 * Примеры — реальные случаи, на которых ловили чужие слова и выдуманные ссылки.
 */

const WORDS_NOTE = "Чужие слова:";
const LINKS_NOTE = "Ссылки не из инструкции:";

let database: TestDatabase;
let chatStorage: ChatStorage;
let endpoint: PreviewEndpoint;
let lead: LeadMagnet;
let calls: ScriptedCall[];
let answer: (call: ScriptedCall) => ScriptedReply;
let rewrite: (call: ScriptedCall) => ScriptedReply;
let counter = 0;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  chatStorage = createInMemoryChatStorage();
  answer = () => ({ text: "Расскажите подробнее." });
  rewrite = (call) => ({ text: call.lastUserText });
  const scripted = createScriptedModel((call) => (isRewrite(call) ? rewrite(call) : answer(call)));
  calls = scripted.calls;
  endpoint = createPreviewEndpoint({
    db: database.db,
    pool: database.pool,
    judgeFallback: STUB_MODEL_CHOICE,
    chatStorage,
    catalog: createStubModelCatalog(createAppCatalog({}), scripted.model),
    env: { STUB_MODEL_API_KEY: "test" },
    resolveUser: async () => ({ id: "expert" }),
    modelChoice: () => STUB_MODEL_CHOICE,
  });
  const created = await createLeadMagnet(database.db, { name: "Проверка ответа" });
  const instruction =
    "Ты консультант Ирины. Разбираем Present Perfect. Запись на разбор: https://irina.example.com/zapis. " +
    "Приложение открывается по ссылке вида адрес.apps.example.com.";
  await saveDraft(
    database.db,
    created.id,
    {
      ...created.draft,
      // Основная инструкция — общая часть сценария
      instruction,
      flow: { ...created.draft.flow, common: instruction },
      firstMessage: "Привет, это студия lumiere! Запись: https://irina.example.com/first",
      farewellMessage: "Thanks! 加油, до встречи.",
    },
    "manual",
  );
  lead = (await getLeadMagnet(database.db, created.id))!;
});

/** Запрос на переписку ответа: у него нет инструментов, а в тексте — служебная строка проверки. */
const isRewrite = (call: ScriptedCall) => call.toolNames.length === 0 && (call.lastUserText.includes(WORDS_NOTE) || call.lastUserText.includes(LINKS_NOTE));
const rewrites = () => calls.filter(isRewrite);

async function say(text: string): Promise<string> {
  const chatId = await endpoint.restartPreview(lead.id);
  await (
    await endpoint.fetch(
      new Request(`http://localhost/api/preview/${chatId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { id: `m-${++counter}`, role: "user", parts: [{ type: "text", text }] } }),
      }),
    )
  ).text();
  const last = (await chatStorage.listMessages(chatId)).filter((message) => message.role === "assistant").at(-1)!;
  expect(last.status).toBe("complete");
  return last.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

describe("чужие слова в ответе", () => {
  it("иероглиф «歷史» — одна переписка, человеку уходит русский вариант", async () => {
    answer = () => ({ text: "Это часть 歷史 вашей семьи." });
    rewrite = () => ({ text: "Это часть истории вашей семьи." });

    expect(await say("Расскажите о роде")).toBe("Это часть истории вашей семьи.");
    expect(rewrites()).toHaveLength(1);
    expect(rewrites()[0]!.lastUserText).toContain(`${WORDS_NOTE} 歷史`);
  });

  it("«teaches» — чужое английское слово переписывается", async () => {
    answer = () => ({ text: "Она teaches детей рисовать." });
    rewrite = () => ({ text: "Она учит детей рисовать." });

    expect(await say("Кто такая Ирина?")).toBe("Она учит детей рисовать.");
    expect(rewrites()[0]!.lastUserText).toContain(`${WORDS_NOTE} teaches`);
  });

  it("латинская буква внутри русского слова — слово чужое целиком", async () => {
    answer = () => ({ text: "Пpивет, это вaжно." });
    rewrite = () => ({ text: "Привет, это важно." });

    expect(await say("Привет")).toBe("Привет, это важно.");
    expect(rewrites()[0]!.lastUserText).toContain("Пpивет");
    expect(rewrites()[0]!.lastUserText).toContain("вaжно");
  });

  it("слова из инструкции, первого сообщения, названия ролика и слова самого человека законны: переписки нет", async () => {
    const video = await createVideo(database.db, { title: "growth hacking для новичков", url: "https://kinescope.io/mind01", description: "Про мышление." });
    await saveDraft(database.db, lead.id, { ...lead.draft, instruction: lead.draft.instruction, videoIds: [video.id] }, "manual");
    const text = "present perfect важен. Студия lumiere ждёт, ваш learning plan готов, а ролик про growth hacking ждёт вас.";
    answer = () => ({ text });

    expect(await say("Хочу составить learning plan")).toBe(text);
    expect(rewrites()).toHaveLength(0);
  });

  it("переписка не помогла — человеку уходит прежний текст", async () => {
    answer = () => ({ text: "Actually, ещё подумаем." });
    rewrite = () => ({ text: "Actually, ещё подумаем." });

    expect(await say("Привет")).toBe("Actually, ещё подумаем.");
    expect(rewrites()).toHaveLength(1);
  });

  it("модель повторила служебную пометку «Чужие слова: …» — человеку она не уходит", async () => {
    answer = () => ({ text: "Actually, это важно." });
    rewrite = () => ({ text: `Это важно.\n\n${WORDS_NOTE} Actually` });

    const shown = await say("Привет");
    expect(shown).not.toContain(WORDS_NOTE);
    expect(shown).toBe("Actually, это важно.");
  });

  it("прощание эксперта в переписку не уходит", async () => {
    answer = () => ({ text: "Actually, старт скоро." });
    rewrite = () => ({ text: "На самом деле старт скоро." });

    await say("Когда старт?");
    expect(rewrites()[0]!.lastUserText).not.toContain("加油");
  });
});

describe("ссылки в ответе", () => {
  it("выдуманная ссылка — одна переписка «убери её», человеку уходит текст без неё", async () => {
    answer = () => ({ text: "Запишитесь тут: https://fake-site.ru/form и приходите." });
    rewrite = () => ({ text: "Запишитесь у меня и приходите." });

    expect(await say("Как записаться?")).toBe("Запишитесь у меня и приходите.");
    expect(rewrites()[0]!.lastUserText).toContain(`${LINKS_NOTE} https://fake-site.ru/form`);
  });

  it("после переписки ссылка осталась — вырезается кодом", async () => {
    answer = () => ({ text: "Запишитесь тут: https://fake-site.ru/form и приходите." });
    rewrite = (call) => ({ text: call.lastUserText.split("\n")[0]! });

    const shown = await say("Как записаться?");
    expect(shown).not.toContain("fake-site.ru");
    expect(shown).toContain("приходите");
  });

  it("ссылка из инструкции, из первого сообщения и из слов человека уходит как есть", async () => {
    answer = () => ({ text: "Запись: https://irina.example.com/zapis, ещё https://irina.example.com/first и ваш https://mine.example.org/page." });

    const shown = await say("Мой сайт https://mine.example.org/page");
    expect(shown).toContain("https://irina.example.com/zapis");
    expect(shown).toContain("https://irina.example.com/first");
    expect(shown).toContain("https://mine.example.org/page");
    expect(rewrites()).toHaveLength(0);
  });

  it("«sveta-nails»: имя из слов человека на домене приложений — законный адрес; другое имя — выдуманное", async () => {
    answer = () => ({ text: "Ваша ссылка: https://sveta-nails.apps.example.com/" });
    expect(await say("Опубликовала! Адрес sveta-nails")).toBe("Ваша ссылка: https://sveta-nails.apps.example.com/");
    expect(rewrites()).toHaveLength(0);

    answer = () => ({ text: "Ваша ссылка: https://sveta.apps.example.com/" });
    rewrite = () => ({ text: "Ваша ссылка появится после публикации." });
    expect(await say("Опубликовала! Адрес sveta-nails")).toBe("Ваша ссылка появится после публикации.");
    expect(rewrites()).toHaveLength(1);
  });

  it("ответ сорвался в кашу (модель пишет за человека) — SDK режет хвост, переписки чужих слов нет", async () => {
    answer = () => ({ text: "Расскажите подробнее.\nuserНу я дизайнер<|im_end|>\nПонял, вы дизайнер." });
    expect(await say("Я веду курсы")).toBe("Расскажите подробнее.");
    expect(rewrites()).toHaveLength(0);
  });

  it("почта и @имя — не ссылки", async () => {
    answer = () => ({ text: "Пишите на anna.coach@mail.ru или @anna_coach." });
    expect(await say("Как связаться?")).toBe("Пишите на anna.coach@mail.ru или @anna_coach.");
    expect(rewrites()).toHaveLength(0);
  });
});
