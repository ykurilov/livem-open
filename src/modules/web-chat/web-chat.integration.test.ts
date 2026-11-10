import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, KIT_CIPHER, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { bots, outboundMessages } from "../channels/schema";
import { inboundMessages, passages } from "../conversations/schema";
import { replyFromInbox } from "../inbox";
import { createLabeledLink, newProgramSettings } from "../lead-magnets";
import { listLabeledLinks } from "../lead-magnets/links";
import { describePublication, unpublishLeadMagnet } from "../lead-magnets/publish";
import { profileNameForTail } from "../consultant/profile-name";
import { people } from "../people/schema";
import {
  FEED_FIRST_LOAD_LIMIT,
  MESSAGE_MAX_LENGTH,
  MESSAGES_PER_DAY,
  MESSAGES_PER_MINUTE,
  SEEN_WRITE_GAP_MS,
  findWebChatVisitor,
  forgetWebChatSubscription,
  markWebChatAway,
  newVisitorsPerAddress,
  openWebChat,
  readWebChat,
  saveWebChatSubscription,
  sendWebChatMessage,
  sessionsPerAddress,
  webChatImagePath,
  webChatResumeCode,
  webChatElsewhere,
  webChatTitle,
  webChatVoiceInput,
  type WebChatDependencies,
} from ".";

let database: TestDatabase;
let kit: LiveDialogKit;
let deps: WebChatDependencies;
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
  deps = { db: kit.db, queue: kit.queue, clock: kit.clock, cipher: KIT_CIPHER };
  address = `test-${randomUUID()}`;
});

async function open(code: string, token: string | null = null, resume: string | null = null) {
  const opened = await openWebChat(deps, { token, resume, code, address });
  if (opened.kind !== "opened") throw new Error(`Чат не открылся: ${opened.kind}`);
  await kit.drain();
  return opened;
}

async function visitorOf(token: string) {
  const visitor = await findWebChatVisitor(kit.db, token);
  if (!visitor) throw new Error("Посетитель не найден");
  return visitor;
}

async function say(token: string, text: string, code?: string) {
  const result = await sendWebChatMessage(deps, await visitorOf(token), { text, clientId: randomUUID(), address, code });
  await kit.drain();
  return result;
}

async function feed(token: string) {
  return readWebChat(kit.db, kit.clock, await visitorOf(token));
}

describe("веб-чат лидмагнита", () => {
  it("ссылка с меткой начинает разговор: человек — «Веб-чат» с этой меткой, первое сообщение в ленте", async () => {
    const lead = await kit.publish({ firstMessage: "Здравствуйте! Что у вас за бизнес?" });
    const blogger = await createLabeledLink(kit.db, { leadMagnetId: lead.leadMagnetId, label: "Блогер Маша" });

    const opened = await open(blogger.code);
    expect(opened.issued).toBe(true);
    expect(opened.token.length).toBeGreaterThanOrEqual(40);

    const visitor = await visitorOf(opened.token);
    const [person] = await kit.db.select().from(people).where(eq(people.externalUserId, visitor.id));
    expect(person).toMatchObject({ channel: "web" });
    const [bot] = await kit.db.select().from(bots).where(eq(bots.id, person!.botId));
    expect(bot).toMatchObject({ channel: "web", title: "Веб-чат" });

    const [passage] = await kit.db.select().from(passages).where(eq(passages.personId, person!.id));
    expect(passage).toMatchObject({ leadMagnetId: lead.leadMagnetId, entryLinkId: blogger.id, status: "active" });

    const items = await feed(opened.token);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ from: "bot" });
    expect(items[0]!.text).toContain("Здравствуйте! Что у вас за бизнес?");
  });

  it("разговор идёт через консультанта, возврат по той же ссылке не начинает его заново", async () => {
    const lead = await kit.publish();
    const opened = await open(lead.code);

    expect(await say(opened.token, "Я веду курсы")).toMatchObject({ ok: true });
    const texts = (await feed(opened.token)).map((item) => [item.from, item.text]);
    expect(texts).toEqual([
      ["bot", expect.stringContaining("Привет! Чем вы занимаетесь?")],
      ["person", "Я веду курсы"],
      ["bot", "Понял. Расскажите подробнее."],
    ]);

    const again = await open(lead.code, opened.token);
    expect(again.issued).toBe(false);
    expect(again.token).toBe(opened.token);
    expect(await feed(opened.token)).toHaveLength(3);
    const visitor = await visitorOf(opened.token);
    const [person] = await kit.db.select().from(people).where(eq(people.externalUserId, visitor.id));
    expect(await kit.db.select().from(passages).where(eq(passages.personId, person!.id))).toHaveLength(1);
  });

  it("чужой или выдуманный токен не видит чужой переписки: это новый посетитель", async () => {
    const lead = await kit.publish();
    const anna = await open(lead.code);
    await say(anna.token, "Секрет Анны");

    expect(await findWebChatVisitor(kit.db, "выдуманный-токен")).toBeNull();
    const stranger = await open(lead.code, "выдуманный-токен");
    expect(stranger.issued).toBe(true);
    expect(stranger.token).not.toBe(anna.token);
    expect((await feed(stranger.token)).map((item) => item.text)).not.toContain("Секрет Анны");
  });

  it("неизвестный код — чата нет", async () => {
    expect(await openWebChat(deps, { token: null, code: "нет-такого", address })).toEqual({ kind: "not_found" });
  });

  it("длинное сообщение и поток сообщений отклоняются", async () => {
    const lead = await kit.publish();
    const opened = await open(lead.code);
    const visitor = await visitorOf(opened.token);

    const tooLong = await sendWebChatMessage(deps, visitor, { text: "а".repeat(MESSAGE_MAX_LENGTH + 1), clientId: randomUUID(), address });
    expect(tooLong).toMatchObject({ ok: false });
    expect(await sendWebChatMessage(deps, visitor, { text: "   ", clientId: randomUUID(), address })).toMatchObject({ ok: false });

    expect(await sendWebChatMessage(deps, visitor, { text: "раз", clientId: randomUUID(), address })).toMatchObject({ ok: true });
    // Сразу второе — слишком часто
    expect(await sendWebChatMessage(deps, visitor, { text: "два", clientId: randomUUID(), address })).toMatchObject({ ok: false });

    for (let sent = 1; sent < MESSAGES_PER_MINUTE; sent++) {
      kit.clock.advance(1_500);
      expect(await sendWebChatMessage(deps, visitor, { text: `ещё ${sent}`, clientId: randomUUID(), address })).toMatchObject({ ok: true });
    }
    kit.clock.advance(1_500);
    expect(await sendWebChatMessage(deps, visitor, { text: "лишнее", clientId: randomUUID(), address })).toMatchObject({ ok: false });
    kit.clock.advance(60_000);
    expect(await sendWebChatMessage(deps, visitor, { text: "через минуту", clientId: randomUUID(), address })).toMatchObject({ ok: true });
  });

  it("повтор того же сообщения (тот же clientId) не создаёт второго", async () => {
    const lead = await kit.publish();
    const opened = await open(lead.code);
    const visitor = await visitorOf(opened.token);
    const clientId = randomUUID();
    const first = await sendWebChatMessage(deps, visitor, { text: "Привет", clientId, address });
    expect(first).toMatchObject({ ok: true, item: { from: "person", text: "Привет" } });
    kit.clock.advance(5_000);
    const repeated = await sendWebChatMessage(deps, visitor, { text: "Привет", clientId, address });
    expect(repeated).toEqual(first);
    await kit.drain();
    const person = (await feed(opened.token)).filter((item) => item.from === "person");
    expect(person).toHaveLength(1);
    // Сообщение из ответа на отправку и из ленты — одно и то же: страница не покажет его дважды
    expect(first.ok && first.item?.id).toBe(person[0]!.id);
  });

  it("ответ эксперта из «Входящих» приходит в ленту, а закрытой странице — уведомлением", async () => {
    const lead = await kit.publish();
    const opened = await open(lead.code);
    const visitor = await visitorOf(opened.token);
    const [person] = await kit.db.select().from(people).where(eq(people.externalUserId, visitor.id));

    await replyFromInbox(deps, { personId: person!.id, text: "Это Дмитрий, отвечаю сам", seenUpTo: kit.clock.now(), requestId: randomUUID() });
    await kit.drain();

    const items = await feed(opened.token);
    expect(items.at(-1)).toMatchObject({ from: "bot", text: "Это Дмитрий, отвечаю сам" });
    expect(kit.webNotified.at(-1)).toMatchObject({ to: visitor.id, message: expect.objectContaining({ text: "Это Дмитрий, отвечаю сам" }) });
  });

  it("картинка и ролик консультанта — в ленте картинкой и плеером; картинку отдают только своему посетителю", async () => {
    const lead = await kit.publish();
    const anna = await open(lead.code);
    const boris = await open(lead.code);
    const visitor = await visitorOf(anna.token);
    const [person] = await kit.db.select().from(people).where(eq(people.externalUserId, visitor.id));
    const [message] = await kit.db
      .insert(outboundMessages)
      .values({
        botId: person!.botId,
        personId: person!.id,
        kind: "consultant",
        text: "Нажмите сюда",
        imagePath: "/uploads/image-1.png",
        video: { title: "Как упаковать курс", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=200s", startLabel: "3:20" },
        followUps: ["До встречи!"],
        status: "sent",
        sentAt: kit.clock.now(),
        idempotencyKey: `web-media:${randomUUID()}`,
      })
      .returning();

    const items = await feed(anna.token);
    const media = items.filter((item) => item.id.startsWith(message!.id));
    expect(media).toEqual([
      expect.objectContaining({ text: "Нажмите сюда", imageUrl: `/api/web-chat/images/${message!.id}` }),
      expect.objectContaining({
        video: expect.objectContaining({ title: "Как упаковать курс", embedUrl: expect.stringContaining("dQw4w9WgXcQ") }),
      }),
      expect.objectContaining({ text: "До встречи!" }),
    ]);

    expect(await webChatImagePath(kit.db, visitor, message!.id)).toBe("/uploads/image-1.png");
    expect(await webChatImagePath(kit.db, await visitorOf(boris.token), message!.id)).toBeNull();
  });

  it("готовые ответы консультанта — у последнего элемента его сообщения; пустой список в ленту не идёт", async () => {
    const lead = await kit.publish();
    const anna = await open(lead.code);
    const visitor = await visitorOf(anna.token);
    const [person] = await kit.db.select().from(people).where(eq(people.externalUserId, visitor.id));
    const insert = (values: { text: string; followUps?: string[]; quickReplies: string[] }) =>
      kit.db
        .insert(outboundMessages)
        .values({
          botId: person!.botId,
          personId: person!.id,
          kind: "consultant",
          status: "sent",
          sentAt: kit.clock.now(),
          idempotencyKey: `web-quick:${randomUUID()}`,
          ...values,
        })
        .returning();
    const [asked] = await insert({ text: "Как удобнее?", followUps: ["И ещё одно"], quickReplies: ["Утром", "Вечером"] });
    const [plain] = await insert({ text: "Понял", quickReplies: [] });

    const items = await feed(anna.token);
    expect(items.filter((item) => item.id.startsWith(asked!.id))).toEqual([
      expect.not.objectContaining({ quickReplies: expect.anything() }),
      expect.objectContaining({ text: "И ещё одно", quickReplies: ["Утром", "Вечером"] }),
    ]);
    expect(items.find((item) => item.id === plain!.id)).not.toHaveProperty("quickReplies");
  });

  it("веб-ссылка видна в «Публикации» и у каждой ссылки с меткой", async () => {
    const lead = await kit.publish();
    const blogger = await createLabeledLink(kit.db, { leadMagnetId: lead.leadMagnetId, label: "Блогер" });
    const adapters = kit.dialogAdapters;

    const publication = await describePublication(kit.db, adapters, lead.leadMagnetId);
    expect(publication.webLink).toBe(`https://lm.test/c/${lead.code}`);
    const [labeled] = await listLabeledLinks(kit.db, adapters, lead.leadMagnetId);
    expect(labeled!.urls).toContainEqual({ channel: "web", url: `https://lm.test/c/${blogger.code}` });
  });

  it("код входа веб-приложения одноразовый и не равен токену: первый запуск получает свой токен, браузер остаётся в чате", async () => {
    const lead = await kit.publish();
    const browser = await open(lead.code);
    const visitor = await visitorOf(browser.token);
    const resume = await webChatResumeCode(kit.db, KIT_CIPHER, visitor);
    expect(resume).not.toBe(browser.token);
    // Манифест перечитывают — код тот же, пока его не использовали
    expect(await webChatResumeCode(kit.db, KIT_CIPHER, await visitorOf(browser.token))).toBe(resume);

    const app = await open(lead.code, null, resume);
    expect(app).toMatchObject({ issued: true, visitorId: visitor.id });
    expect(app.token).not.toBe(browser.token);
    expect((await visitorOf(app.token)).id).toBe(visitor.id);
    expect((await visitorOf(browser.token)).id).toBe(visitor.id);

    // Ответ первого запуска потерялся по дороге: повтор с тем же кодом — тот же посетитель, а не новый пустой чат
    const retried = await open(lead.code, null, resume);
    expect(retried.visitorId).toBe(visitor.id);
    // Веб-приложение вошло и перечитало манифест — код гаснет, в манифесте новый
    const next = await webChatResumeCode(kit.db, KIT_CIPHER, await visitorOf(app.token));
    expect(next).not.toBe(resume);
    expect(await webChatResumeCode(kit.db, KIT_CIPHER, await visitorOf(browser.token))).toBe(next);
    // Погасший код — уже никто: новый посетитель без чужой переписки
    const replay = await open(lead.code, null, resume);
    expect(replay.visitorId).not.toBe(visitor.id);
  });

  it("ответ из вкладки другого лидмагнита не уходит в текущий разговор", async () => {
    const first = await kit.publish();
    const second = await kit.publish();
    const opened = await open(first.code);
    await open(second.code, opened.token);
    const visitor = await visitorOf(opened.token);

    const stale = await sendWebChatMessage(deps, visitor, { text: "Ответ про первый", clientId: randomUUID(), address, code: first.code });
    // Страница покажет, какой разговор идёт, и даст перейти в него — обновить страницу в веб-приложении нечем
    expect(stale).toMatchObject({ ok: false, reason: "other_chat", current: { code: second.code } });
    expect((await feed(opened.token)).map((item) => item.text)).not.toContain("Ответ про первый");

    kit.clock.advance(2_000);
    expect(await sendWebChatMessage(deps, visitor, { text: "Про второй", clientId: randomUUID(), address, code: second.code })).toMatchObject({ ok: true });
  });

  it("очередь не приняла начало разговора — открытие честно не удалось, cookie нового посетителя остаётся, повтор начинает разговор", async () => {
    const lead = await kit.publish();
    const broken = { ...deps, queue: { enqueue: async () => Promise.reject(new Error("очередь недоступна")) } };
    const failed = await openWebChat(broken, { token: null, code: lead.code, address });
    expect(failed).toMatchObject({ kind: "retry", issued: true });
    if (failed.kind !== "retry") throw new Error("ожидали retry");

    const again = await open(lead.code, failed.token);
    expect(again.visitorId).toBe((await visitorOf(failed.token)).id);
    expect((await feed(failed.token)).at(0)).toMatchObject({ from: "bot" });
  });

  it("веб-посетители различимы по имени, а консультант не получает его как имя из профиля", async () => {
    const lead = await kit.publish();
    const anna = await open(lead.code);
    const boris = await open(lead.code);
    await say(anna.token, "Привет");
    const nameOf = async (token: string) => {
      const [person] = await kit.db.select().from(people).where(eq(people.externalUserId, (await visitorOf(token)).id));
      return person!;
    };
    const annaPerson = await nameOf(anna.token);
    expect(annaPerson.displayName).toMatch(/^Гость веб-чата \S+$/);
    expect(annaPerson.displayName).not.toBe((await nameOf(boris.token)).displayName);
    expect(await profileNameForTail(kit.db, annaPerson.id)).toBeNull();
  });

  it("пояс браузера становится поясом человека; узнанный в разговоре пояс не перезаписывается", async () => {
    const lead = await kit.publish();
    const opened = await openWebChat(deps, { token: null, code: lead.code, address, timeZone: "Asia/Vladivostok" });
    if (opened.kind !== "opened") throw new Error(opened.kind);
    await kit.drain();
    const personOf = async () => (await kit.db.select().from(people).where(eq(people.externalUserId, opened.visitorId)))[0]!;
    expect((await personOf()).timeZone).toBe("Asia/Vladivostok");

    await kit.db.update(people).set({ timeZone: "Europe/Berlin" }).where(eq(people.externalUserId, opened.visitorId));
    await openWebChat(deps, { token: opened.token, code: lead.code, address, timeZone: "Asia/Vladivostok" });
    expect((await personOf()).timeZone).toBe("Europe/Berlin");

    const odd = await openWebChat(deps, { token: null, code: lead.code, address, timeZone: "Луна/Море" });
    if (odd.kind !== "opened") throw new Error(odd.kind);
    await kit.drain();
    const [oddPerson] = await kit.db.select().from(people).where(eq(people.externalUserId, odd.visitorId));
    expect(oddPerson!.timeZone).toBeNull();
  });

  it("лидмагнит сняли с публикации — свой посетитель открывает переписку, новый и чужой — нет", async () => {
    const lead = await kit.publish({ name: "Курс по йоге" });
    const opened = await open(lead.code);
    await say(opened.token, "Я веду курсы");
    const other = await kit.publish();
    const stranger = await open(other.code);
    await unpublishLeadMagnet(kit.db, lead.leadMagnetId);

    const back = await open(lead.code, opened.token);
    expect(back).toMatchObject({ issued: false, title: "Курс по йоге" });
    expect(await webChatTitle(kit.db, lead.code, await visitorOf(opened.token))).toBe("Курс по йоге");
    expect((await feed(opened.token)).map((item) => item.text)).toContain("Я веду курсы");

    expect(await openWebChat(deps, { token: null, code: lead.code, address })).toEqual({ kind: "not_found" });
    expect(await openWebChat(deps, { token: stranger.token, code: lead.code, address })).toEqual({ kind: "not_found" });
    expect(await webChatTitle(kit.db, lead.code, null)).toBeNull();
  });

  it("голосовой ввод — по опубликованной версии лидмагнита ссылки, в том числе ссылки с меткой; снятый или чужой код — без голоса", async () => {
    const voiced = await kit.publish({ voiceInput: true });
    const blogger = await createLabeledLink(kit.db, { leadMagnetId: voiced.leadMagnetId, label: "Блогер" });
    const silent = await kit.publish();
    expect(await webChatVoiceInput(kit.db, voiced.code)).toBe(true);
    expect(await webChatVoiceInput(kit.db, blogger.code)).toBe(true);
    expect(await webChatVoiceInput(kit.db, silent.code)).toBe(false);
    expect(await webChatVoiceInput(kit.db, "no-such-code")).toBe(false);
    await unpublishLeadMagnet(kit.db, voiced.leadMagnetId);
    expect(await webChatVoiceInput(kit.db, voiced.code)).toBe(false);
  });

  it("снятый лидмагнит, а идёт разговор другого — чат закончен, без ленты, с адресом текущего разговора", async () => {
    const closed = await kit.publish({ name: "Курс по йоге" });
    const current = await kit.publish({ name: "Курс по танцам" });
    const opened = await open(closed.code);
    await open(current.code, opened.token);
    await unpublishLeadMagnet(kit.db, closed.leadMagnetId);
    const visitor = await visitorOf(opened.token);

    const elsewhere = { title: "Курс по йоге", current: { code: current.code, title: "Курс по танцам" } };
    expect(await webChatElsewhere(kit.db, closed.code, visitor, kit.clock.now())).toEqual(elsewhere);
    expect(await openWebChat(deps, { token: opened.token, code: closed.code, address })).toMatchObject({ kind: "closed", issued: false, ...elsewhere });
    // Свой идущий разговор и опубликованный лидмагнит — не «закончен»
    expect(await webChatElsewhere(kit.db, current.code, visitor, kit.clock.now())).toBeNull();
    await unpublishLeadMagnet(kit.db, current.leadMagnetId);
    expect(await webChatElsewhere(kit.db, current.code, visitor, kit.clock.now())).toBeNull();
    expect(await open(current.code, opened.token)).toMatchObject({ title: "Курс по танцам" });
  });

  it("программа лидмагнита закончилась, а идёт разговор другого — старая ссылка: чат закончен, с адресом текущего", async () => {
    const ended = await kit.publish({ name: "Марафон", program: newProgramSettings(3) });
    const current = await kit.publish({ name: "Курс по танцам" });
    const opened = await open(ended.code);
    const visitor = await visitorOf(opened.token);
    await kit.db.update(passages).set({ status: "completed", endedAt: kit.clock.now(), nextReminderAt: null }).where(eq(passages.leadMagnetId, ended.leadMagnetId));
    await open(current.code, opened.token);

    const elsewhere = { title: "Марафон", current: { code: current.code, title: "Курс по танцам" } };
    expect(await webChatElsewhere(kit.db, ended.code, visitor, kit.clock.now())).toEqual(elsewhere);
    expect(await openWebChat(deps, { token: opened.token, code: ended.code, address })).toMatchObject({ kind: "closed", issued: false, ...elsewhere });
    expect(await webChatElsewhere(kit.db, current.code, visitor, kit.clock.now())).toBeNull();
    // Законченный разговор без программы по своей ссылке начинается заново — не «закончен»
    const plain = await kit.publish({ name: "Разбор" });
    await open(plain.code, opened.token);
    await open(current.code, opened.token);
    expect(await webChatElsewhere(kit.db, plain.code, visitor, kit.clock.now())).toBeNull();
  });

  it("подписка на уведомления — за одним посетителем: тот же браузер с новым посетителем забирает её у прежнего", async () => {
    const lead = await kit.publish();
    const before = await open(lead.code);
    const after = await open(lead.code);
    const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "p", auth: "a" } };
    await saveWebChatSubscription(kit.db, await visitorOf(before.token), subscription);
    await saveWebChatSubscription(kit.db, await visitorOf(after.token), subscription);
    expect((await visitorOf(before.token)).pushSubscription).toBeNull();
    expect((await visitorOf(after.token)).pushSubscription).toEqual(subscription);
  });

  it("отказ службы уведомлений по прежней подписке не стирает новую, сохранённую за это время", async () => {
    const lead = await kit.publish();
    const opened = await open(lead.code);
    const earlier = { endpoint: "https://fcm.googleapis.com/fcm/send/old", keys: { p256dh: "p", auth: "a" } };
    const later = { endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: { p256dh: "p", auth: "a" } };
    await saveWebChatSubscription(kit.db, await visitorOf(opened.token), earlier);
    await saveWebChatSubscription(kit.db, await visitorOf(opened.token), later);
    const visitorId = (await visitorOf(opened.token)).id;
    await forgetWebChatSubscription(kit.db, visitorId, earlier.endpoint);
    expect((await visitorOf(opened.token)).pushSubscription).toEqual(later);
    await forgetWebChatSubscription(kit.db, visitorId, later.endpoint);
    expect((await visitorOf(opened.token)).pushSubscription).toBeNull();
  });

  it("с одного адреса: открытий чата — до предела в минуту, новых посетителей — до предела в час", async () => {
    const lead = await kit.publish();
    const opened = await open(lead.code);
    const sessions = sessionsPerAddress(address).limit;
    for (let attempt = 1; attempt < sessions; attempt++) await openWebChat(deps, { token: opened.token, code: `нет-${attempt}`, address });
    expect(await openWebChat(deps, { token: opened.token, code: lead.code, address })).toMatchObject({ kind: "limited" });
    kit.clock.advance(60_000);
    expect(await openWebChat(deps, { token: opened.token, code: lead.code, address })).toMatchObject({ kind: "opened", issued: false });

    const visitors = newVisitorsPerAddress(address).limit;
    for (let created = 1; created < visitors; created++) {
      if (created % 100 === 0) kit.clock.advance(60_000);
      expect(await openWebChat(deps, { token: null, code: lead.code, address })).toMatchObject({ kind: "opened", issued: true });
    }
    kit.clock.advance(60_000);
    expect(await openWebChat(deps, { token: null, code: lead.code, address })).toMatchObject({ kind: "limited" });
    // Свой посетитель с того же адреса входит, другой адрес — тоже
    expect(await openWebChat(deps, { token: opened.token, code: lead.code, address })).toMatchObject({ kind: "opened" });
    expect(await openWebChat(deps, { token: null, code: lead.code, address: `${address}-другой` })).toMatchObject({ kind: "opened" });
  }, 60_000);

  it("суточный потолок сообщений посетителя", async () => {
    const lead = await kit.publish();
    const opened = await open(lead.code);
    const visitor = await visitorOf(opened.token);
    const [person] = await kit.db.select().from(people).where(eq(people.externalUserId, visitor.id));
    const earlier = new Date(kit.clock.now().getTime() - 60 * 60_000);
    await kit.db.insert(inboundMessages).values(
      Array.from({ length: MESSAGES_PER_DAY }, (_, index) => ({
        botId: person!.botId,
        kind: "message" as const,
        dedupeKey: `web-day:${visitor.id}:${index}`,
        externalUserId: visitor.id,
        text: `старое ${index}`,
        receivedAt: earlier,
      })),
    );
    expect(await sendWebChatMessage(deps, visitor, { text: "ещё", clientId: randomUUID(), address })).toMatchObject({ ok: false, reason: "too_many" });
    kit.clock.advance(24 * 60 * 60_000);
    expect(await sendWebChatMessage(deps, visitor, { text: "назавтра", clientId: randomUUID(), address })).toMatchObject({ ok: true });
  });

  it("первая загрузка ленты — только последние элементы, отметку «открыта» пишет не каждый опрос, скрытая страница её стирает", async () => {
    const lead = await kit.publish();
    const opened = await open(lead.code);
    const visitor = await visitorOf(opened.token);
    const [person] = await kit.db.select().from(people).where(eq(people.externalUserId, visitor.id));
    const start = kit.clock.now().getTime();
    await kit.db.insert(outboundMessages).values(
      Array.from({ length: FEED_FIRST_LOAD_LIMIT + 10 }, (_, index) => ({
        botId: person!.botId,
        personId: person!.id,
        kind: "consultant" as const,
        text: `сообщение ${index}`,
        status: "sent" as const,
        sentAt: new Date(start + (index + 1) * 1000),
        idempotencyKey: `web-feed:${randomUUID()}`,
      })),
    );
    kit.clock.advance(SEEN_WRITE_GAP_MS);
    const items = await feed(opened.token);
    expect(items).toHaveLength(FEED_FIRST_LOAD_LIMIT);
    expect(items.at(-1)!.text).toBe(`сообщение ${FEED_FIRST_LOAD_LIMIT + 9}`);
    const seen = (await visitorOf(opened.token)).lastSeenAt;
    expect(seen).toEqual(kit.clock.now());

    kit.clock.advance(SEEN_WRITE_GAP_MS - 1);
    await feed(opened.token);
    expect((await visitorOf(opened.token)).lastSeenAt).toEqual(seen);

    await markWebChatAway(kit.db, await visitorOf(opened.token));
    expect((await visitorOf(opened.token)).lastSeenAt).toBeNull();
  });

  it("сообщение, ушедшее эксперту без автоответа, помечено: «печатает» не нужно", async () => {
    const lead = await kit.publish();
    const opened = await open(lead.code);
    const visitor = await visitorOf(opened.token);
    const [person] = await kit.db.select().from(people).where(eq(people.externalUserId, visitor.id));
    await kit.db.update(passages).set({ status: "completed", endedAt: kit.clock.now() }).where(eq(passages.personId, person!.id));

    await say(opened.token, "А когда созвон?");
    kit.clock.advance(5_000);
    await say(opened.token, "И сколько стоит?");
    const people_ = (await feed(opened.token)).filter((item) => item.from === "person");
    // Первое — с автоответом «скоро свяжусь», второе ждёт эксперта
    expect(people_.map((item) => [item.text, item.noReply])).toEqual([
      ["А когда созвон?", undefined],
      ["И сколько стоит?", true],
    ]);
  });

  it("возврат к ссылке после законченного разговора — к переписке; переход с другого лидмагнита — снова этот", async () => {
    const first = await kit.publish();
    const second = await kit.publish();
    const opened = await open(first.code);
    const visitor = await visitorOf(opened.token);
    const [person] = await kit.db.select().from(people).where(eq(people.externalUserId, visitor.id));
    const passagesOf = (leadMagnetId: string) =>
      kit.db.select().from(passages).where(and(eq(passages.personId, person!.id), eq(passages.leadMagnetId, leadMagnetId)));

    await open(second.code, opened.token);
    expect(await passagesOf(second.leadMagnetId)).toMatchObject([{ status: "active" }]);
    await open(first.code, opened.token);
    const firstAgain = await passagesOf(first.leadMagnetId);
    expect(firstAgain.map((passage) => passage.status).sort()).toEqual(["active", "not_completed"]);

    await kit.db.update(passages).set({ status: "completed", endedAt: kit.clock.now() }).where(eq(passages.personId, person!.id));
    await open(first.code, opened.token);
    await open(first.code, opened.token);
    expect(await passagesOf(first.leadMagnetId)).toHaveLength(2);
  });

  it("брошенный разговор другого лидмагнита не отвечает со страницы прежнего: по ссылке — снова этот", async () => {
    const yoga = await kit.publish({ name: "Курс по йоге" });
    const dance = await kit.publish({ name: "Курс по танцам" });
    const opened = await open(yoga.code);
    await open(dance.code, opened.token);
    const visitor = await visitorOf(opened.token);
    const [person] = await kit.db.select().from(people).where(eq(people.externalUserId, visitor.id));
    // Разговор про танцы брошен: закрыт как «не завершил», но сообщение без кода его бы продолжило
    kit.clock.advance(3 * 24 * 60 * 60_000);
    await kit.db.update(passages).set({ status: "not_completed", endedAt: kit.clock.now() }).where(eq(passages.leadMagnetId, dance.leadMagnetId));

    // Вкладка йоги открыта с прошлого раза: сообщение не уходит в танцы, страница предложит перейти
    const stale = await sendWebChatMessage(deps, visitor, { text: "Про йогу", clientId: randomUUID(), address, code: yoga.code });
    expect(stale).toMatchObject({ ok: false, reason: "other_chat", current: { code: dance.code, title: "Курс по танцам" } });

    await open(yoga.code, opened.token);
    expect(await say(opened.token, "Снова про йогу", yoga.code)).toMatchObject({ ok: true });
    const [inbound] = await kit.db.select().from(inboundMessages).where(eq(inboundMessages.text, "Снова про йогу"));
    const [yogaActive] = await kit.db
      .select()
      .from(passages)
      .where(and(eq(passages.personId, person!.id), eq(passages.leadMagnetId, yoga.leadMagnetId), eq(passages.status, "active")));
    expect(inbound?.passageId).toBe(yogaActive!.id);
    expect(await kit.db.select({ status: passages.status }).from(passages).where(eq(passages.leadMagnetId, dance.leadMagnetId))).toEqual([
      { status: "not_completed" },
    ]);
  });

  it("программа закончилась или лидмагнит снят, а недавно брошен разговор другого — чат закончен, с адресом брошенного", async () => {
    const ended = await kit.publish({ name: "Марафон", program: newProgramSettings(3) });
    const removed = await kit.publish({ name: "Курс по йоге" });
    const dance = await kit.publish({ name: "Курс по танцам" });
    const opened = await open(removed.code);
    const visitor = await visitorOf(opened.token);
    await open(ended.code, opened.token);
    await kit.db.update(passages).set({ status: "completed", endedAt: kit.clock.now(), nextReminderAt: null }).where(eq(passages.leadMagnetId, ended.leadMagnetId));
    await open(dance.code, opened.token);
    await unpublishLeadMagnet(kit.db, removed.leadMagnetId);
    kit.clock.advance(3 * 24 * 60 * 60_000);
    await kit.db.update(passages).set({ status: "not_completed", endedAt: kit.clock.now() }).where(eq(passages.leadMagnetId, dance.leadMagnetId));

    const current = { code: dance.code, title: "Курс по танцам" };
    for (const [code, title] of [[ended.code, "Марафон"], [removed.code, "Курс по йоге"]] as const) {
      expect(await webChatElsewhere(kit.db, code, visitor, kit.clock.now())).toEqual({ title, current });
      expect(await openWebChat(deps, { token: opened.token, code, address })).toMatchObject({ kind: "closed", title, current });
      expect(await sendWebChatMessage(deps, visitor, { text: "Привет", clientId: randomUUID(), address, code })).toMatchObject({
        ok: false,
        reason: "other_chat",
        current,
      });
    }
    // Брошенный больше недели назад уже не продолжится — писать некуда, кроме эксперта: чат не «закончен»
    kit.clock.advance(8 * 24 * 60 * 60_000);
    expect(await webChatElsewhere(kit.db, ended.code, visitor, kit.clock.now())).toBeNull();
  });
});
