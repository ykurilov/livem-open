import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, DEFAULT_CONSULTANT_REPLY, KIT_CIPHER, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { bots, outboundMessages } from "../channels/schema";
import { inboundMessages } from "../conversations/schema";
import { loadInboxThread } from "../inbox";
import { createMemoryAttachmentStorage } from "@ykurilov/agent-chat-attachments";
import { leadMagnetReport } from "../lead-magnets/stats";
import { people } from "../people/schema";
import { webChatVoiceChatId } from "../voice/access";
import { findWebChatVisitor } from "../web-chat";
import {
  CHAT_API_VISITOR_HEADER,
  chatVoiceVisitorId,
  createChatApi,
  createChatSignatures,
  issueChatApiKey,
  readAllowedSites,
  readChatApiKey,
  revokeChatApiKey,
  saveAllowedSites,
  type ChatApi,
  type ChatApiDependencies,
} from ".";
import { chatApiKeys } from "./schema";

const APP = "https://livem.test";
const SITE = "https://expert-site.ru";

let database: TestDatabase;
let kit: LiveDialogKit;
let deps: ChatApiDependencies;
let api: ChatApi;
/** Свой адрес у каждого теста: ограничения по адресу живут в общей базе. */
let address: string;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database);
  address = `test-${randomUUID()}`;
  deps = {
    db: kit.db,
    queue: kit.queue,
    clock: kit.clock,
    cipher: KIT_CIPHER,
    adapters: kit.dialogAdapters,
    appOrigin: APP,
    signatures: createChatSignatures("chat-api-test-key", kit.clock),
    voiceConfigured: true,
    uploadsDir: kit.uploadsDir,
  };
  api = createChatApi(deps);
});

type Init = { method?: string; origin?: string | null; token?: string; visitor?: string; body?: unknown; headers?: Record<string, string> };

/** Запрос браузера с сайта эксперта (`origin`) или сервера эксперта (`origin: null` и ключ в `token`). */
function request(path: string, init: Init = {}) {
  const headers = new Headers({ "x-real-ip": address, ...init.headers });
  if (init.origin !== null) headers.set("origin", init.origin ?? SITE);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.visitor !== undefined) headers.set(CHAT_API_VISITOR_HEADER, init.visitor);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${APP}${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

type Message = { id: string; from: string; text: string; imageUrl?: string; quickReplies?: string[] };

async function openSession(code: string, init: Omit<Init, "body"> = {}) {
  const response = await api.session(request(`/api/v1/chats/${code}/session`, { ...init, body: { timeZone: "Europe/Moscow" } }), code);
  await kit.drain();
  return { response, body: (await response.json()) as { token?: string; title?: string; voiceTicket?: string | null; error?: string } };
}

async function history(code: string, init: Omit<Init, "body"> = {}) {
  const response = await api.messages(request(`/api/v1/chats/${code}/messages`, init), code);
  return { response, body: (await response.json()) as { messages?: Message[]; handoff?: unknown; error?: string } };
}

async function say(code: string, text: string, init: Omit<Init, "body"> = {}) {
  const response = await api.send(request(`/api/v1/chats/${code}/messages`, { ...init, body: { text, clientId: randomUUID() } }), code);
  await kit.drain();
  return response;
}

const fromServer = (key: string, visitor: string) => ({ origin: null, token: key, visitor });

describe("разрешённые сайты лидмагнита", () => {
  it("сохраняются разобранными, непринятые строки возвращаются эксперту; без записи — пусто", async () => {
    const lead = await kit.publish();
    expect(await readAllowedSites(kit.db, lead.leadMagnetId)).toEqual([]);
    expect(await saveAllowedSites(kit.db, lead.leadMagnetId, "https://Example.ru/page\n*.example.ru\nне домен")).toEqual({
      sites: ["example.ru", "*.example.ru"],
      invalid: ["не домен"],
    });
    expect(await readAllowedSites(kit.db, lead.leadMagnetId)).toEqual(["example.ru", "*.example.ru"]);
    await saveAllowedSites(kit.db, lead.leadMagnetId, "");
    expect(await readAllowedSites(kit.db, lead.leadMagnetId)).toEqual([]);
  });
});

describe("API из браузера", () => {
  it("вход без cookie: токен в ответе, разговор веб-чата с первым сообщением, ответ консультанта по токену", async () => {
    const lead = await kit.publish();
    const chat = await api.chat(request(`/api/v1/chats/${lead.code}`), lead.code);
    expect(chat.status).toBe(200);
    expect(chat.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(await chat.json()).toEqual({ title: expect.any(String), photos: false, voice: false });

    const { response, body } = await openSession(lead.code);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(body.token!.length).toBeGreaterThanOrEqual(40);

    // Тот же посетитель и бот веб-чата: разговор виден в отчётах и «Входящих» как разговор веб-чата
    const visitor = await findWebChatVisitor(kit.db, body.token!);
    const [person] = await kit.db.select().from(people).where(eq(people.externalUserId, visitor!.id));
    const [bot] = await kit.db.select().from(bots).where(eq(bots.id, person!.botId));
    expect(bot).toMatchObject({ channel: "web" });

    expect((await history(lead.code, { token: body.token! })).body.messages).toEqual([
      expect.objectContaining({ from: "bot", text: expect.stringContaining("Привет! Чем вы занимаетесь?") }),
    ]);
    expect((await say(lead.code, "Я веду курсы", { token: body.token! })).status).toBe(200);
    expect((await history(lead.code, { token: body.token! })).body.messages!.map((item) => [item.from, item.text])).toEqual([
      ["bot", expect.stringContaining("Привет!")],
      ["person", "Я веду курсы"],
      ["bot", DEFAULT_CONSULTANT_REPLY],
    ]);
  });

  it("человек возвращается с тем же токеном — тот же разговор, без нового начала", async () => {
    const lead = await kit.publish();
    const first = await openSession(lead.code);
    await say(lead.code, "Я веду курсы", { token: first.body.token! });
    const again = await openSession(lead.code, { token: first.body.token! });
    expect(again.body.token).toBe(first.body.token);
    expect((await history(lead.code, { token: first.body.token! })).body.messages).toHaveLength(3);
  });

  it("сайт не из списка: ни входа, ни ленты, ни сообщения — разговор не начинается, модель не тратится", async () => {
    const lead = await kit.publish();
    const allowed = await openSession(lead.code);
    await saveAllowedSites(kit.db, lead.leadMagnetId, "other-site.ru");
    const callsBefore = kit.calls.length;

    const chat = await api.chat(request(`/api/v1/chats/${lead.code}`), lead.code);
    expect(chat.status).toBe(403);
    expect(chat.headers.get("access-control-allow-origin")).toBe(SITE);
    expect((await chat.json()).error).toContain("expert-site.ru");

    const refused = await openSession(lead.code);
    expect(refused.response.status).toBe(403);
    expect(refused.body.token).toBeUndefined();
    expect((await history(lead.code, { token: allowed.body.token! })).response.status).toBe(403);
    expect((await say(lead.code, "Привет", { token: allowed.body.token! })).status).toBe(403);

    const visitor = await findWebChatVisitor(kit.db, allowed.body.token!);
    expect(await kit.db.select().from(inboundMessages).where(eq(inboundMessages.externalUserId, visitor!.id))).toHaveLength(1);
    expect(kit.calls.length).toBe(callsBefore);
  });

  it("сайт из списка и поддомен по маске — работает; без Origin при непустом списке — нет", async () => {
    const lead = await kit.publish();
    await saveAllowedSites(kit.db, lead.leadMagnetId, "expert-site.ru\n*.expert-site.ru");
    expect((await openSession(lead.code)).response.status).toBe(200);
    expect((await openSession(lead.code, { origin: "https://shop.expert-site.ru" })).response.status).toBe(200);
    expect((await openSession(lead.code, { origin: null })).response.status).toBe(403);
  });

  it("свой адрес приложения разрешён всегда: живой просмотр в кабинете", async () => {
    const lead = await kit.publish();
    await saveAllowedSites(kit.db, lead.leadMagnetId, "other-site.ru");
    expect((await openSession(lead.code, { origin: APP })).response.status).toBe(200);
    // Запрос с той же страницы приложения браузер может прислать без Origin
    const sameOrigin = await api.chat(request(`/api/v1/chats/${lead.code}`, { origin: null, headers: { "sec-fetch-site": "same-origin" } }), lead.code);
    expect(sameOrigin.status).toBe(200);
  });

  it("без токена или с чужим — история не отдаётся; неизвестный код — 404", async () => {
    const lead = await kit.publish();
    expect((await history(lead.code)).response.status).toBe(401);
    expect((await history(lead.code, { token: "made-up-token" })).response.status).toBe(401);
    expect((await api.chat(request("/api/v1/chats/нет-такого"), "нет-такого")).status).toBe(404);
    expect((await openSession("нет-такого")).response.status).toBe(404);
  });

  it("предварительный запрос браузера разрешает заголовок токена с сайта", async () => {
    const response = api.preflight(request("/api/v1/chats/x/session", { method: "OPTIONS" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("картинка консультанта — по подписанной ссылке от приложения, только этому посетителю", async () => {
    const lead = await kit.publish();
    const { body } = await openSession(lead.code);
    const visitor = await findWebChatVisitor(kit.db, body.token!);
    const [person] = await kit.db.select().from(people).where(eq(people.externalUserId, visitor!.id));
    const dir = await mkdtemp(join(tmpdir(), "chat-api-images-"));
    const fileName = `image-${randomUUID()}.png`;
    await writeFile(join(dir, fileName), Buffer.from("png-bytes"));
    const [message] = await kit.db
      .insert(outboundMessages)
      .values({
        botId: person!.botId,
        personId: person!.id,
        kind: "consultant",
        text: "Нажмите сюда",
        imagePath: `/uploads/${fileName}`,
        status: "sent",
        sentAt: kit.clock.now(),
        idempotencyKey: `chat-api-media:${randomUUID()}`,
      })
      .returning();

    const messages = (await history(lead.code, { token: body.token! })).body.messages!;
    const imageUrl = messages.find((item) => item.id === message!.id)?.imageUrl;
    expect(imageUrl?.startsWith(`${APP}/api/v1/images/${message!.id}?`)).toBe(true);

    const imageApi = createChatApi({ ...deps, uploadsDir: dir });
    const image = await imageApi.image(new Request(imageUrl!), message!.id);
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer()).toString()).toBe("png-bytes");
    const forged = new URL(imageUrl!);
    forged.searchParams.set("s", "подделка");
    expect((await imageApi.image(new Request(forged), message!.id)).status).toBe(404);
  });

  it("голос: билет из входа узнаёт посетителя на сайте из списка, на чужом — нет", async () => {
    const lead = await kit.publish({ voiceInput: true });
    const chat = await api.chat(request(`/api/v1/chats/${lead.code}`), lead.code);
    expect(await chat.json()).toMatchObject({ voice: true });
    const { body } = await openSession(lead.code);
    const visitor = await findWebChatVisitor(kit.db, body.token!);
    expect(body.voiceTicket).toEqual(expect.any(String));

    const voiceRequest = (origin: string, ticket = body.voiceTicket!) =>
      new Request(`${APP}/api/voice/stream?chat=${webChatVoiceChatId(lead.code)}&ticket=${encodeURIComponent(ticket)}`, { headers: { origin } });
    expect(await chatVoiceVisitorId(deps, voiceRequest(SITE))).toBe(visitor!.id);
    expect(await chatVoiceVisitorId(deps, voiceRequest(SITE, "подделка"))).toBeNull();
    await saveAllowedSites(kit.db, lead.leadMagnetId, "other-site.ru");
    expect(await chatVoiceVisitorId(deps, voiceRequest(SITE))).toBeNull();
    expect(await chatVoiceVisitorId(deps, voiceRequest("https://other-site.ru"))).toBe(visitor!.id);
  });
});

describe("ключ лидмагнита", () => {
  it("показывается один раз: в базе только хэш, в кабинете — начало и дата; новый заменяет прежний", async () => {
    const lead = await kit.publish();
    expect(await readChatApiKey(kit.db, lead.leadMagnetId)).toBeNull();
    const first = await issueChatApiKey(kit.db, lead.leadMagnetId);
    expect(first.key).toMatch(/^lmk_[A-Za-z0-9_-]{40,}$/);
    const shown = await readChatApiKey(kit.db, lead.leadMagnetId);
    expect(shown).toEqual({ keyStart: first.key.slice(0, 10), createdAt: expect.any(Date) });
    expect(JSON.stringify(await kit.db.select().from(chatApiKeys))).not.toContain(first.key.slice(10));

    const second = await issueChatApiKey(kit.db, lead.leadMagnetId);
    expect((await openSession(lead.code, fromServer(first.key, "v-1"))).response.status).toBe(401);
    expect((await openSession(lead.code, fromServer(second.key, "v-1"))).response.status).toBe(200);
  });

  it("отозванный и выдуманный ключ — 401; ключ другого лидмагнита — 403; разговор не начинается", async () => {
    const lead = await kit.publish();
    const other = await kit.publish();
    const { key } = await issueChatApiKey(kit.db, lead.leadMagnetId);
    const { key: otherKey } = await issueChatApiKey(kit.db, other.leadMagnetId);
    const callsBefore = kit.calls.length;

    expect((await openSession(lead.code, fromServer("lmk_made_up_key", "v-1"))).response.status).toBe(401);
    const foreign = await openSession(lead.code, fromServer(otherKey, "v-1"));
    expect(foreign.response.status).toBe(403);
    expect(foreign.body.error).toBeTruthy();
    await revokeChatApiKey(kit.db, lead.leadMagnetId);
    expect(await readChatApiKey(kit.db, lead.leadMagnetId)).toBeNull();
    expect((await openSession(lead.code, fromServer(key, "v-1"))).response.status).toBe(401);
    expect((await history(lead.code, fromServer(key, "v-1"))).response.status).toBe(401);
    expect(kit.calls.length).toBe(callsBefore);
  });

  it("ключ из браузера не принимается: запрос с Origin — 403", async () => {
    const lead = await kit.publish();
    const { key } = await issueChatApiKey(kit.db, lead.leadMagnetId);
    const response = await openSession(lead.code, { token: key, visitor: "v-1" });
    expect(response.response.status).toBe(403);
    expect(response.response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("без id посетителя — 400", async () => {
    const lead = await kit.publish();
    const { key } = await issueChatApiKey(kit.db, lead.leadMagnetId);
    expect((await openSession(lead.code, { origin: null, token: key })).response.status).toBe(400);
    expect((await openSession(lead.code, fromServer(key, ""))).response.status).toBe(400);
  });
});

describe("API с сервера эксперта", () => {
  it("свои посетители эксперта не смешиваются; разговор виден в отчёте и «Входящих»", async () => {
    const lead = await kit.publish();
    const { key } = await issueChatApiKey(kit.db, lead.leadMagnetId);
    const anna = fromServer(key, "crm-anna");
    const boris = fromServer(key, "crm-boris");

    const opened = await openSession(lead.code, anna);
    expect(opened.response.status).toBe(200);
    // Токен посетителя серверу не нужен и наружу не уходит
    expect(opened.body.token).toBeUndefined();
    expect((await say(lead.code, "Я Анна, веду йогу", anna)).status).toBe(200);
    expect((await history(lead.code, boris)).response.status).toBe(401);
    await openSession(lead.code, boris);

    expect((await history(lead.code, anna)).body.messages!.map((item) => [item.from, item.text])).toEqual([
      ["bot", expect.stringContaining("Привет!")],
      ["person", "Я Анна, веду йогу"],
      ["bot", DEFAULT_CONSULTANT_REPLY],
    ]);
    expect((await history(lead.code, boris)).body.messages!.map((item) => item.from)).toEqual(["bot"]);

    // Повторный вход того же посетителя — тот же разговор
    await openSession(lead.code, anna);
    expect((await history(lead.code, anna)).body.messages).toHaveLength(3);

    const report = await leadMagnetReport(kit.db, lead.leadMagnetId);
    expect(report.byLink.reduce((sum, row) => sum + row.arrived, 0)).toBe(2);
    const webPeople = await kit.db.select({ person: people }).from(people).innerJoin(bots, eq(bots.id, people.botId)).where(eq(bots.channel, "web"));
    const threads = await Promise.all(webPeople.map(({ person }) => loadInboxThread(kit.db, person.id)));
    const annaThread = threads.find((thread) => thread?.messages.some((message) => message.text === "Я Анна, веду йогу"));
    expect(annaThread?.person.channel).toBe("web");
  });

  it("одновременный первый вход одного посетителя заводит одного человека", async () => {
    const lead = await kit.publish();
    const { key } = await issueChatApiKey(kit.db, lead.leadMagnetId);
    const visitor = fromServer(key, "crm-same");
    const sessions = await Promise.all([1, 2, 3].map(() => api.session(request(`/api/v1/chats/${lead.code}/session`, { ...visitor, body: {} }), lead.code)));
    await kit.drain();
    expect(sessions.map((response) => response.status)).toEqual([200, 200, 200]);
    expect((await history(lead.code, visitor)).body.messages!.filter((item) => item.from === "bot")).toHaveLength(1);
    const report = await leadMagnetReport(kit.db, lead.leadMagnetId);
    expect(report.byLink.reduce((sum, row) => sum + row.arrived, 0)).toBe(1);
  });

  it("разрешённые сайты к серверу не относятся: запрос без Origin с ключом работает при непустом списке", async () => {
    const lead = await kit.publish();
    await saveAllowedSites(kit.db, lead.leadMagnetId, "other-site.ru");
    const { key } = await issueChatApiKey(kit.db, lead.leadMagnetId);
    expect((await openSession(lead.code, fromServer(key, "crm-1"))).response.status).toBe(200);
  });
});

/** Настоящий PNG 1×1: SDK читает картинку целиком, одного заголовка ему мало. */
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

/** Сообщение с фото — формой, как его шлёт браузер или сервер. */
async function sendPhoto(code: string, init: Omit<Init, "body">, photo: Uint8Array, text = "Вот мой экран") {
  const form = new FormData();
  form.set("text", text);
  form.set("clientId", randomUUID());
  form.set("photo", new Blob([photo as BlobPart], { type: "image/png" }), "screen.png");
  const base = request(`/api/v1/chats/${code}/messages`, init);
  const response = await api.send(new Request(base.url, { method: "POST", headers: base.headers, body: form }), code);
  await kit.drain();
  return { response, body: (await response.json()) as { ok?: boolean; item?: Message; error?: string } };
}

describe("фото клиента", () => {
  it("лидмагнит принимает картинки: фото доходит до консультанта, видно в истории по подписанной ссылке и во «Входящих»", async () => {
    const lead = await kit.publish({ clientImages: true });
    expect(await (await api.chat(request(`/api/v1/chats/${lead.code}`), lead.code)).json()).toMatchObject({ photos: true });
    const { body } = await openSession(lead.code);

    const sent = await sendPhoto(lead.code, { token: body.token! }, PNG);
    expect(sent.response.status).toBe(200);
    expect(sent.body.item).toMatchObject({ from: "person", text: "Вот мой экран", imageUrl: expect.stringContaining(`${APP}/api/v1/images/`) });

    const call = kit.consultantCalls().at(-1)!;
    const imageParts = call.options.prompt
      .filter((message) => message.role === "user")
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "file" && part.mediaType.startsWith("image/"));
    expect(imageParts).toHaveLength(1);

    const photoItem = (await history(lead.code, { token: body.token! })).body.messages!.find((item) => item.from === "person");
    expect(photoItem?.imageUrl).toEqual(sent.body.item!.imageUrl);
    const image = await api.image(new Request(photoItem!.imageUrl!), photoItem!.id);
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);

    // «Входящие» показывают фото: веб-чат отдаёт его по ссылке из входящего, как мессенджер
    const visitor = await findWebChatVisitor(kit.db, body.token!);
    const [person] = await kit.db.select().from(people).where(eq(people.externalUserId, visitor!.id));
    const thread = await loadInboxThread(kit.db, person!.id, {
      clientImages: createMemoryAttachmentStorage(),
      uploadsDir: kit.uploadsDir,
      messengers: { adapters: kit.dialogAdapters, cipher: KIT_CIPHER },
    });
    expect(thread?.messages.find((message) => message.text === "Вот мой экран")).toMatchObject({ image: { url: expect.any(String) } });
  });

  it("фото без подписи тоже принимается; с сервера эксперта — так же", async () => {
    const lead = await kit.publish({ clientImages: true });
    const { key } = await issueChatApiKey(kit.db, lead.leadMagnetId);
    await openSession(lead.code, fromServer(key, "crm-photo"));
    const sent = await sendPhoto(lead.code, fromServer(key, "crm-photo"), PNG, "");
    expect(sent.response.status).toBe(200);
    expect(sent.body.item).toMatchObject({ from: "person", text: "", imageUrl: expect.any(String) });
  });

  it("лидмагнит не принимает картинки — 400, сообщение не уходит; не картинка — 400", async () => {
    const off = await kit.publish();
    const offSession = await openSession(off.code);
    const refused = await sendPhoto(off.code, { token: offSession.body.token! }, PNG);
    expect(refused.response.status).toBe(400);
    expect(refused.body.error).toContain("фото");
    expect((await history(off.code, { token: offSession.body.token! })).body.messages!.map((item) => item.from)).toEqual(["bot"]);

    const on = await kit.publish({ clientImages: true });
    const onSession = await openSession(on.code);
    const notImage = await sendPhoto(on.code, { token: onSession.body.token! }, new Uint8Array(Buffer.from("это не картинка")));
    expect(notImage.response.status).toBe(400);
  });
});
