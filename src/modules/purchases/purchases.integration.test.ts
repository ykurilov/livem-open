// Оплата продукта: метка в ссылке, приём уведомления GetCourse, поздравление один раз,
// одно напоминание назавтра, запасной путь по почте. Часы и очередь подменены, модель — по сценарию теста.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, outboundOf, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import type { ScriptedCall, ScriptedReply } from "../platform/scripted-model";
import { updateSettings } from "../platform/settings";
import type { ProductLink } from "./product-links";
import { passages } from "../conversations/schema";
import { productOrders } from "./schema";
import { purchaseReport } from "./report";
import { acceptGetCourseWebhook, MAX_NOTICE_BYTES } from "./webhook";
import { parseGetCourseNotice } from "./getcourse";
import { recordOrderNotice } from "./orders";
import * as reactions from "./reactions";
import { remindPayment } from "./reactions";
import { passagePurchasePort } from "./ports";
import { people } from "../people/schema";
import { createPassageConversationStore } from "../conversations/passage-store";
import { PREVIEW_MEDIUM, previewTrackingCode } from "./preview-code";
import { providerOutage } from "../../../tests/integration/live-dialog-kit";
import { requeueStuckOutbound } from "../channels";

// 14:00 по Москве 21 октября
const START = new Date("2026-10-21T11:00:00Z");
const SECRET = "s3cr3t-getcourse-hook";
const COURSE: ProductLink = { url: "https://school.example.com/ai_agent_course", title: "Свой ИИ-агент", campaign: "ai_agent_course" };
const SETTINGS = {
  instruction: `Ты Василий. Помогай собрать приложение. Курс «Свой ИИ-агент»: ${COURSE.url}`,
  productLinks: [COURSE],
};

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;

beforeAll(async () => {
  database = await createTestDatabase();
  await updateSettings(database.db, { dailyLimitUsd: "1000", monthlyBudgetUsd: null });
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query("do $$ begin if to_regclass('agent_chat.flow_chats') is not null then delete from agent_chat.flow_chats; end if; end $$");
  kit = await createLiveDialogKit(database, { start: START, pricePerMillion: 0 });
  person = `user-${randomUUID().slice(0, 8)}`;
  kit.reply = scripted;
});

/** Служебное сообщение события приложения (оплата, напоминание) модель видит текстом в последнем сообщении. */
const isEvent = (call: ScriptedCall, words: string) => call.lastUserText.includes(words);

function scripted(call: ScriptedCall): ScriptedReply {
  if (call.lastToolResult !== undefined) {
    const next = JSON.stringify(call.lastToolResult);
    if (next.includes("Оплата есть")) return { text: "Вижу оплату — поздравляю!" };
    if (next.includes("уже учтена")) return { text: "Да, оплата уже дошла, всё в порядке." };
    if (next.includes("Попроси почту")) return { text: "С какой почты вы платили?" };
    if (next.includes("с этой почтой пока не видно")) return { text: "Пока не вижу оплату, проверю позже." };
    return { text: `Отлично! Вот ссылка: ${COURSE.url}` };
  }
  if (isEvent(call, "Пришла оплата")) return { text: "Поздравляю с покупкой курса! 🎉" };
  if (isEvent(call, "Вчера человек собирался оплатить")) return { text: `Напоминаю про курс: ${COURSE.url}` };
  const text = call.lastUserText.toLowerCase();
  if (text.includes("беру")) return { toolCalls: [{ toolName: "payment_promised", input: {} }] };
  if (text.includes("оплатил")) {
    const email = call.lastUserText.match(/\S+@\S+/)?.[0];
    return { toolCalls: [{ toolName: "payment_check", input: email ? { email } : {} }] };
  }
  if (text.includes("ссылк")) return { text: `Курс здесь: ${COURSE.url}. Там оба тарифа.` };
  return { text: "Понял. Расскажите подробнее." };
}

async function start() {
  const lead = await kit.publish(SETTINGS);
  await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
  await kit.runDue();
  return lead;
}

async function say(text: string) {
  await kit.send(person, text);
  await kit.runDue();
  kit.clock.advance(5_000);
  await kit.runDue();
  await kit.dialog.flow.settled();
}

const passage = async () => (await kit.passagesOf(person))[0]!;
const depsOf = () => Promise.resolve({ db: kit.db, queue: kit.queue, clock: kit.clock });
const notify = (body: Record<string, unknown>, secret = SECRET) =>
  acceptGetCourseWebhook(
    { expectedSecret: SECRET, deps: depsOf },
    { secret, contentType: "application/json", contentLength: null, readBody: async () => JSON.stringify(body) },
  );
const lastText = () => kit.textsTo(person).at(-1) ?? "";

/** Сообщения, которые Василий написал этому человеку первым. */
async function firstMessagesToPerson(): Promise<string[]> {
  const personId = (await kit.personOf(person))!.id;
  return (await outboundOf(kit)).filter((row) => row.kind === "outreach" && row.personId === personId).map((row) => row.text);
}

describe("ссылка продукта с меткой", () => {
  it("человек получает ссылку с каналом и личным кодом, а история модели — без меток", async () => {
    await start();
    await say("Дайте ссылку на курс");

    const code = (await passage()).trackingCode!;
    expect(code).toMatch(/^[a-z2-9]{8}$/);
    expect(lastText()).toBe(
      `Курс здесь: ${COURSE.url}?utm_source=vasily&utm_medium=telegram&utm_campaign=ai_agent_course&utm_content=${code}. Там оба тарифа.`,
    );

    // Следующий ход: модель видит свой прошлый ответ как написала, без меток — начало запроса то же
    await say("Спасибо");
    const prompt = JSON.stringify(kit.consultantCalls().at(-1)!.options.prompt);
    expect(prompt).toContain(COURSE.url);
    expect(prompt).not.toContain("utm_");
    // Проверка ссылок не вырезала ссылку продукта
    expect(lastText()).toBe("Понял. Расскажите подробнее.");
  });

  it("у лидмагнита без ссылок продукта ссылка уходит как есть, код не заводится", async () => {
    const lead = await kit.publish({ instruction: SETTINGS.instruction });
    await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
    await kit.runDue();
    await say("Дайте ссылку на курс");
    expect(lastText()).toBe(`Курс здесь: ${COURSE.url}. Там оба тарифа.`);
    expect((await passage()).trackingCode).toBeNull();
  });
});

describe("уведомление GetCourse", () => {
  it("чужой секрет — 404, без id заказа — 400, ничего не записано", async () => {
    expect((await notify({ id: "1", status: "Завершён" }, "wrong")).status).toBe(404);
    expect((await notify({ status: "Завершён" })).status).toBe(400);
    expect(await kit.db.select().from(productOrders).where(eq(productOrders.externalOrderId, "1"))).toHaveLength(0);
  });

  it("оплата по личному коду: покупка, одно поздравление первым; повтор уведомления ничего не повторяет", async () => {
    await start();
    await say("Дайте ссылку на курс");
    const { trackingCode, id } = await passage();
    const orderId = `gc-${randomUUID().slice(0, 6)}`;
    const body = { event: "order_paid", id: orderId, number: "4711", status: "Завершён", cost: "2990", email: "anna@mail.ru", utm_content: trackingCode };

    expect(await notify(body)).toEqual({ status: 200, body: { ok: true, matched: true } });
    await kit.runDue();
    await notify(body);
    await kit.runDue();

    const [order] = await kit.db.select().from(productOrders).where(eq(productOrders.externalOrderId, orderId));
    expect(order).toMatchObject({ passageId: id, matchedBy: "code", amount: "2990.00" });
    expect((await passage()).purchasedAt).not.toBeNull();
    expect(await firstMessagesToPerson()).toEqual(["Поздравляю с покупкой курса! 🎉"]);
    expect(lastText()).toBe("Поздравляю с покупкой курса! 🎉");

    // Дальше в хвосте — «уже оплатил»: не продавать
    await say("Как опубликовать приложение?");
    expect(kit.consultantCalls().at(-1)!.lastUserText).toContain("уже оплатил курс «Свой ИИ-агент»");
  });

  it("опоздавшее «создан» после «оплачен» не откатывает статус и не ставит напоминание", async () => {
    await start();
    await say("Дайте ссылку на курс");
    const { trackingCode } = await passage();
    const orderId = `gc-${randomUUID().slice(0, 6)}`;
    await notify({ event: "order_paid", id: orderId, status: "Завершён", utm_content: trackingCode });
    await notify({ event: "order_created", id: orderId, status: "Новый", utm_content: trackingCode });
    const [order] = await kit.db.select().from(productOrders).where(eq(productOrders.externalOrderId, orderId));
    expect(order?.status).toBe("Завершён");
    expect(kit.queue.count("payment-reminder")).toBe(0);
  });

  it("неизвестный заказ записан без человека; найдётся по почте, названной Василию", async () => {
    await start();
    const orderId = `gc-${randomUUID().slice(0, 6)}`;
    expect((await notify({ event: "order_paid", id: orderId, status: "Завершён", email: "Pay@Mail.ru" })).body.matched).toBe(false);

    await say("Я оплатил");
    expect(lastText()).toBe("С какой почты вы платили?");
    await say("Я оплатил с pay@mail.ru");
    expect(lastText()).toBe("Вижу оплату — поздравляю!");

    const [order] = await kit.db.select().from(productOrders).where(eq(productOrders.externalOrderId, orderId));
    expect(order).toMatchObject({ passageId: (await passage()).id, matchedBy: "email" });
    // Поздравил в ответе — задача поздравления второй раз не пишет
    await kit.drain();
    expect(await firstMessagesToPerson()).toEqual([]);
    expect((await passage()).purchaseCongratulatedAt).not.toBeNull();
  });

  it("оплаты нет — честно «проверю позже»; придёт заказ с этой почтой — поздравление", async () => {
    await start();
    await say("Я оплатил, почта late@mail.ru");
    expect(lastText()).toBe("Пока не вижу оплату, проверю позже.");

    await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", email: "late@mail.ru" });
    await kit.runDue();
    expect(await firstMessagesToPerson()).toEqual(["Поздравляю с покупкой курса! 🎉"]);
  });
});

describe("напоминание об оплате", () => {
  it("обещал оплатить — назавтра в 11:00 одно напоминание со ссылкой в метках; больше не напоминает", async () => {
    await start();
    await say("Беру курс");
    expect((await passage()).paymentPromisedAt).not.toBeNull();
    await say("Беру, точно");

    kit.clock.set(new Date("2026-10-22T07:59:00Z"));
    await kit.runDue();
    expect(await firstMessagesToPerson()).toEqual([]);

    kit.clock.set(new Date("2026-10-22T08:00:00Z"));
    await kit.drain();
    const code = (await passage()).trackingCode;
    expect(await firstMessagesToPerson()).toEqual([`Напоминаю про курс: ${COURSE.url}?utm_source=vasily&utm_medium=telegram&utm_campaign=ai_agent_course&utm_content=${code}`]);

    kit.clock.set(new Date("2026-10-24T08:00:00Z"));
    await kit.drain();
    expect(await firstMessagesToPerson()).toHaveLength(1);
  });

  it("оформил заказ, но не оплатил — одно напоминание назавтра", async () => {
    await start();
    await say("Дайте ссылку на курс");
    const { trackingCode } = await passage();
    await notify({ event: "order_created", id: `gc-${randomUUID().slice(0, 6)}`, status: "Новый", utm_content: trackingCode });
    expect((await passage()).purchasedAt).toBeNull();

    kit.clock.set(new Date("2026-10-22T09:00:00Z"));
    await kit.drain();
    expect(await firstMessagesToPerson()).toHaveLength(1);
    expect((await firstMessagesToPerson())[0]).toContain("Напоминаю про курс");
  });

  it("оплатившему не напоминает", async () => {
    await start();
    await say("Беру курс");
    const { trackingCode } = await passage();
    await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", utm_content: trackingCode });

    kit.clock.set(new Date("2026-10-23T09:00:00Z"));
    await kit.drain();
    expect(await firstMessagesToPerson()).toEqual(["Поздравляю с покупкой курса! 🎉"]);
  });
});

describe("отчёт «Покупки»", () => {
  it("оформили заказ, оплатили и сумма — по людям лидмагнита; чужие и неизвестные заказы не в счёт", async () => {
    const lead = await start();
    await say("Дайте ссылку на курс");
    const { trackingCode } = await passage();
    expect(await purchaseReport(kit.db, lead.leadMagnetId)).toEqual({ ordered: 0, paid: 0, refunded: 0, paidByCurrency: [], promised: 0 });

    await notify({ event: "order_created", id: `gc-${randomUUID().slice(0, 6)}`, status: "Новый", cost: "2990", utm_content: trackingCode });
    await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", cost: "1990", utm_content: trackingCode });
    await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", cost: "5000", email: "stranger@mail.ru" });
    await say("Беру курс");

    expect(await purchaseReport(kit.db, lead.leadMagnetId)).toEqual({ ordered: 1, paid: 1, refunded: 0, paidByCurrency: [{ currency: "RUB", amount: 1990 }], promised: 0 });
  });

  it("лидмагнит без ссылок продуктов и заказов — без отчёта", async () => {
    const lead = await kit.publish({ instruction: SETTINGS.instruction });
    expect(await purchaseReport(kit.db, lead.leadMagnetId)).toBeNull();
  });
});

describe("находки ревью", () => {
  it("секрет — до чтения тела и до очереди; тело больше предела — 413", async () => {
    let read = false;
    let depsAsked = false;
    const wrong = await acceptGetCourseWebhook(
      { expectedSecret: SECRET, deps: () => ((depsAsked = true), depsOf()) },
      { secret: "wrong", contentType: null, contentLength: null, readBody: async () => ((read = true), "{}") },
    );
    expect(wrong.status).toBe(404);
    expect({ read, depsAsked }).toEqual({ read: false, depsAsked: false });

    const declared = await acceptGetCourseWebhook(
      { expectedSecret: SECRET, deps: () => ((depsAsked = true), depsOf()) },
      { secret: SECRET, contentType: null, contentLength: String(MAX_NOTICE_BYTES + 1), readBody: async () => ((read = true), "{}") },
    );
    expect(declared.status).toBe(413);
    expect({ read, depsAsked }).toEqual({ read: false, depsAsked: false });

    const actual = await acceptGetCourseWebhook(
      { expectedSecret: SECRET, deps: depsOf },
      { secret: SECRET, contentType: null, contentLength: null, readBody: async () => JSON.stringify({ id: "big", pad: "x".repeat(MAX_NOTICE_BYTES) }) },
    );
    expect(actual.status).toBe(413);
  });

  it("почта в фактах — только адрес целиком: an@mail.ru не находит человека с ivan@mail.ru", async () => {
    await start();
    const personId = (await kit.personOf(person))!.id;
    await kit.db.update(people).set({ facts: [{ text: "Почта ivan@mail.ru, пишет вечером", at: "", source: "" }] }).where(eq(people.id, personId));
    expect((await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", email: "an@mail.ru" })).body.matched).toBe(false);
    expect((await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", email: "ivan@mail.ru" })).body.matched).toBe(true);
  });

  it("payment_check после поздравления — «оплата уже учтена», без второго поздравления", async () => {
    await start();
    await say("Дайте ссылку на курс");
    const { trackingCode } = await passage();
    await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", utm_content: trackingCode });
    await kit.runDue();
    await say("Я оплатил, дошло?");
    expect(lastText()).toBe("Да, оплата уже дошла, всё в порядке.");
  });

  it("поздравление без «0 ₽»; отчёт складывает суммы по валютам", async () => {
    const lead = await start();
    await say("Дайте ссылку на курс");
    const { trackingCode } = await passage();
    await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", cost: "0.00", utm_content: trackingCode });
    await kit.runDue();
    const notice = kit.consultantCalls().find((call) => call.lastUserText.includes("Пришла оплата"))!.lastUserText;
    expect(notice).not.toContain("0 ₽");

    const other = `user-${randomUUID().slice(0, 8)}`;
    await kit.send(other, `/start ${lead.code}`, { startCode: lead.code });
    await kit.runDue();
    const code = await kit.db.select({ id: passages.id }).from(passages).where(eq(passages.personId, (await kit.personOf(other))!.id));
    await kit.db.update(passages).set({ trackingCode: "usdcode1" }).where(eq(passages.id, code[0]!.id));
    await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", cost: "$1,299.00", utm_content: "usdcode1" });
    expect((await purchaseReport(kit.db, lead.leadMagnetId))?.paidByCurrency).toEqual([
      { currency: "RUB", amount: 0 },
      { currency: "USD", amount: 1299 },
    ]);
  });

  it("ход напоминания видит в хвосте разрешение на ссылку; после него — снова «сам не напоминай»", async () => {
    await start();
    await say("Беру курс");
    const { id, chatId } = await passage();
    const port = passagePurchasePort({ db: kit.db, queue: kit.queue, clock: kit.clock });
    let during: string | null = null;
    const writer = {
      writeFirst: async () => {
        during = await port.tailLine(chatId);
        return { kind: "answer" as const, text: "Напоминаю про курс", video: null, image: null };
      },
    };
    await remindPayment({ db: kit.db, queue: kit.queue, clock: kit.clock, writer }, id);
    expect(during).toMatch(/в этом сообщении можно ссылку на оплату/);
    expect(await port.tailLine(chatId)).toMatch(/сам об оплате не напоминай/);
  });

  it("сбой при напоминании — отметка снята, повтор задачи отправит", async () => {
    await start();
    await say("Беру курс");
    const { id } = await passage();
    const failing = { writeFirst: async () => Promise.reject(new Error("модель упала")) };
    await expect(remindPayment({ db: kit.db, queue: kit.queue, clock: kit.clock, writer: failing }, id)).rejects.toThrow("модель упала");
    expect((await passage()).paymentReminderSentAt).toBeNull();
    const ok = { writeFirst: async () => ({ kind: "answer" as const, text: "Напоминаю про курс", video: null, image: null }) };
    await remindPayment({ db: kit.db, queue: kit.queue, clock: kit.clock, writer: ok }, id);
    expect(await firstMessagesToPerson()).toEqual(["Напоминаю про курс"]);
  });

  it("возврат оплаченного: покупка снята, в отчёте «вернули», Василий первым не пишет", async () => {
    const lead = await start();
    await say("Дайте ссылку на курс");
    const { trackingCode } = await passage();
    const orderId = `gc-${randomUUID().slice(0, 6)}`;
    await notify({ event: "order_paid", id: orderId, status: "Завершён", cost: "2990", utm_content: trackingCode });
    await kit.runDue();
    await notify({ event: "order_refunded", id: orderId, status: "Возврат", utm_content: trackingCode });
    await kit.drain();

    expect((await passage()).purchasedAt).toBeNull();
    const [order] = await kit.db.select().from(productOrders).where(eq(productOrders.externalOrderId, orderId));
    expect(order?.refundedAt).not.toBeNull();
    expect(await purchaseReport(kit.db, lead.leadMagnetId)).toMatchObject({ paid: 0, refunded: 1, paidByCurrency: [] });
    expect(await firstMessagesToPerson()).toEqual(["Поздравляю с покупкой курса! 🎉"]);
  });

  it("названная почта не перебивает метку; привязанный заказ к другому не переходит", async () => {
    await start();
    await say("Дайте ссылку на курс");
    const owner = await passage();

    const other = `user-${randomUUID().slice(0, 8)}`;
    const saved = person;
    person = other;
    await start();
    await say("Я оплатил с shared@mail.ru");
    const stranger = await passage();
    person = saved;

    const orderId = `gc-${randomUUID().slice(0, 6)}`;
    await notify({ event: "order_paid", id: orderId, status: "Завершён", email: "shared@mail.ru", utm_content: owner.trackingCode });
    const [order] = await kit.db.select().from(productOrders).where(eq(productOrders.externalOrderId, orderId));
    expect(order).toMatchObject({ passageId: owner.id, matchedBy: "code" });

    person = other;
    await say("Я оплатил с shared@mail.ru");
    person = saved;
    const [after] = await kit.db.select().from(productOrders).where(eq(productOrders.externalOrderId, orderId));
    expect(after?.passageId).toBe(owner.id);
    expect((await kit.db.select().from(passages).where(eq(passages.id, stranger.id)))[0]?.purchasedAt).toBeNull();
  });
});

describe("находки аудита", () => {
  const recover = () => (reactions as { recoverPurchaseReactions?: (deps: reactions.PurchaseDependencies) => Promise<number> }).recoverPurchaseReactions;

  it("сбой постановки поздравления после записи оплаты: повтор уведомления поздравляет", async () => {
    await start();
    await say("Дайте ссылку на курс");
    const { trackingCode } = await passage();
    const body = { event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", utm_content: trackingCode };
    kit.queue.failNext(1);
    await expect(notify(body)).rejects.toThrow();
    await notify(body);
    await kit.drain();
    expect(await firstMessagesToPerson()).toEqual(["Поздравляю с покупкой курса! 🎉"]);
  });

  it("сбой постановки поздравления без повтора уведомления: подмётчик покупок восстанавливает реакцию", async () => {
    await start();
    await say("Дайте ссылку на курс");
    const { trackingCode } = await passage();
    kit.queue.failNext(1);
    await expect(notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", utm_content: trackingCode })).rejects.toThrow();
    kit.clock.advance(2 * 60_000);
    expect(recover()).toBeTypeOf("function");
    expect(await recover()!({ db: kit.db, queue: kit.queue, clock: kit.clock })).toBe(1);
    await kit.drain();
    expect(await firstMessagesToPerson()).toEqual(["Поздравляю с покупкой курса! 🎉"]);
    // Реакция исполнена: второй обход ничего не делает
    expect(await recover()!({ db: kit.db, queue: kit.queue, clock: kit.clock })).toBe(0);
  });

  it("сбой постановки напоминания по неоплаченному заказу: повтор уведомления ставит его", async () => {
    await start();
    await say("Дайте ссылку на курс");
    const { trackingCode } = await passage();
    const body = { event: "order_created", id: `gc-${randomUUID().slice(0, 6)}`, status: "Новый", utm_content: trackingCode };
    kit.queue.failNext(1);
    await expect(notify(body)).rejects.toThrow();
    await notify(body);
    expect(kit.queue.count("payment-reminder")).toBe(1);
  });

  it("возврат пришёл раньше оплаты: покупки нет, поздравления нет, в отчёте «вернули», статус не откатывается", async () => {
    const lead = await start();
    await say("Дайте ссылку на курс");
    const { trackingCode } = await passage();
    const orderId = `gc-${randomUUID().slice(0, 6)}`;
    await notify({ event: "order_refunded", id: orderId, status: "Возврат", cost: "2990", utm_content: trackingCode });
    await notify({ event: "order_paid", id: orderId, status: "Завершён", cost: "2990", utm_content: trackingCode });
    await notify({ event: "order_created", id: orderId, status: "Новый", utm_content: trackingCode });
    await kit.drain();

    expect((await passage()).purchasedAt).toBeNull();
    expect(await firstMessagesToPerson()).toEqual([]);
    const [order] = await kit.db.select().from(productOrders).where(eq(productOrders.externalOrderId, orderId));
    expect(order?.status).toBe("Возврат");
    expect(await purchaseReport(kit.db, lead.leadMagnetId)).toMatchObject({ ordered: 1, paid: 0, refunded: 1, paidByCurrency: [] });
  });

  it("отмена до оплаты — не возврат: в отчёте не «вернули», напоминания нет", async () => {
    const lead = await start();
    await say("Дайте ссылку на курс");
    const { trackingCode } = await passage();
    await notify({ event: "order_cancelled", id: `gc-${randomUUID().slice(0, 6)}`, status: "Отменён", utm_content: trackingCode });
    expect(await purchaseReport(kit.db, lead.leadMagnetId)).toMatchObject({ ordered: 1, paid: 0, refunded: 0 });
    expect(kit.queue.count("payment-reminder")).toBe(0);
  });

  it("процесс упал посреди напоминания: после срока захвата повтор отправляет одно напоминание", async () => {
    await start();
    await say("Беру курс");
    const { id } = await passage();
    let started = false;
    const crashed = { writeFirst: () => ((started = true), new Promise<never>(() => {})) };
    void remindPayment({ db: kit.db, queue: kit.queue, clock: kit.clock, writer: crashed }, id);
    for (let wait = 0; !started && wait < 200; wait++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toBe(true);

    // Пока захват свежий, вторая задача не пишет
    let early = 0;
    await remindPayment({ db: kit.db, queue: kit.queue, clock: kit.clock, writer: { writeFirst: async () => (early++, { kind: "answer" as const, text: "рано", video: null, image: null }) } }, id);
    expect(early).toBe(0);

    kit.clock.advance(20 * 60_000);
    const ok = { writeFirst: async () => ({ kind: "answer" as const, text: "Напоминаю про курс", video: null, image: null }) };
    await remindPayment({ db: kit.db, queue: kit.queue, clock: kit.clock, writer: ok }, id);
    expect(await firstMessagesToPerson()).toEqual(["Напоминаю про курс"]);
    expect((await passage()).paymentReminderSentAt).not.toBeNull();
  });

  it("напоминание уже в очереди исходящих, а отметки нет (упал после записи): повтор не зовёт модель и не шлёт второе", async () => {
    await start();
    await say("Беру курс");
    const { id } = await passage();
    const ok = { writeFirst: async () => ({ kind: "answer" as const, text: "Напоминаю про курс", video: null, image: null }) };
    await remindPayment({ db: kit.db, queue: kit.queue, clock: kit.clock, writer: ok }, id);
    await kit.db.update(passages).set({ paymentReminderSentAt: null }).where(eq(passages.id, id));

    let calls = 0;
    const counting = { writeFirst: async () => (calls++, { kind: "answer" as const, text: "Второе", video: null, image: null }) };
    await remindPayment({ db: kit.db, queue: kit.queue, clock: kit.clock, writer: counting }, id);
    expect(calls).toBe(0);
    expect(await firstMessagesToPerson()).toEqual(["Напоминаю про курс"]);
    expect((await passage()).paymentReminderSentAt).not.toBeNull();
  });

  it("тестовая оплата из «Проверки» не связывается с боевым человеком ни при приёме, ни при сверке по почте", async () => {
    await start();
    await say("Я оплатил с prev@mail.ru");
    const orderId = `gc-${randomUUID().slice(0, 6)}`;
    const body = { event: "order_paid", id: orderId, status: "Завершён", email: "prev@mail.ru", utm_medium: PREVIEW_MEDIUM, utm_content: previewTrackingCode("chat-x") };
    expect((await notify(body)).body.matched).toBe(false);

    await say("Я оплатил с prev@mail.ru");
    expect(lastText()).toBe("Пока не вижу оплату, проверю позже.");
    const [order] = await kit.db.select().from(productOrders).where(eq(productOrders.externalOrderId, orderId));
    expect(order?.passageId).toBeNull();
    expect((await passage()).purchasedAt).toBeNull();
  });

  it("заказ «Проверки» остаётся тестовым: следующее уведомление без меток и с почтой не связывает его с боевым человеком", async () => {
    await start();
    await say("Я оплатил с prev2@mail.ru");
    const orderId = `gc-${randomUUID().slice(0, 6)}`;
    await notify({ event: "order_created", id: orderId, status: "Новый", utm_medium: PREVIEW_MEDIUM, utm_content: previewTrackingCode("chat-y") });
    expect((await notify({ event: "order_paid", id: orderId, status: "Завершён", email: "prev2@mail.ru" })).body.matched).toBe(false);
    expect((await notify({ event: "order_paid", id: orderId, status: "Завершён", email: "prev2@mail.ru", utm_medium: "telegram" })).body.matched).toBe(false);

    await say("Я оплатил с prev2@mail.ru");
    const [order] = await kit.db.select().from(productOrders).where(eq(productOrders.externalOrderId, orderId));
    expect(order).toMatchObject({ passageId: null, utmMedium: PREVIEW_MEDIUM });
    expect((await passage()).purchasedAt).toBeNull();
  });

  it("частичное уведомление без кампании не теряет сохранённую: заказ чужого продукта по почте не привязывается", async () => {
    await start();
    await say("Я оплатил с part@mail.ru");
    const orderId = `gc-${randomUUID().slice(0, 6)}`;
    await notify({ event: "order_created", id: orderId, status: "Новый", utm_campaign: "other_course" });
    expect((await notify({ event: "order_paid", id: orderId, status: "Завершён", email: "part@mail.ru" })).body.matched).toBe(false);
    expect((await passage()).purchasedAt).toBeNull();
  });

  it("сверка привязала неоплаченный заказ, а очередь упала до напоминания: повтор сверки напоминание ставит", async () => {
    await start();
    await notify({ event: "order_created", id: `gc-${randomUUID().slice(0, 6)}`, status: "Новый", email: "open6@mail.ru" });
    const port = passagePurchasePort({ db: kit.db, queue: kit.queue, clock: kit.clock });
    const { chatId } = await passage();
    kit.queue.failNext();
    await expect(port.check(chatId, "open6@mail.ru")).rejects.toThrow("Очередь недоступна");
    expect(kit.queue.count("payment-reminder")).toBe(0);

    expect(await port.check(chatId, "open6@mail.ru")).toEqual({ kind: "unpaid_order" });
    expect(kit.queue.count("payment-reminder")).toBe(1);
  });

  it("сверка привязала неоплаченный заказ, а очередь упала до напоминания: подмётчик напоминание ставит", async () => {
    await start();
    const orderId = `gc-${randomUUID().slice(0, 6)}`;
    await notify({ event: "order_created", id: orderId, status: "Новый", email: "open7@mail.ru" });
    const deps = { db: kit.db, queue: kit.queue, clock: kit.clock };
    const { chatId } = await passage();
    kit.queue.failNext();
    await expect(passagePurchasePort(deps).check(chatId, "open7@mail.ru")).rejects.toThrow("Очередь недоступна");

    kit.clock.advance(61_000);
    await reactions.recoverPurchaseReactions(deps);
    expect(kit.queue.count("payment-reminder")).toBe(1);
    const [order] = await kit.db.select().from(productOrders).where(eq(productOrders.externalOrderId, orderId));
    expect(order?.reactionPendingAt).toBeNull();
  });

  it("сверка не возвращает покупку, которую снимает идущая реакция на возврат", async () => {
    await start();
    await say("Дайте ссылку на курс");
    const { id, chatId, trackingCode } = await passage();
    await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", utm_content: trackingCode });
    expect((await passage()).purchasedAt).not.toBeNull();

    // Реакция на возврат держит прохождение: возврат записан, покупка снята, но ещё не закоммичено
    const refund = await database.pool.connect();
    try {
      await refund.query("begin");
      await refund.query("select id from app.passages where id = $1 for update", [id]);
      await refund.query("update app.product_orders set refunded_at = now(), status = 'Возврат' where passage_id = $1", [id]);
      await refund.query("update app.passages set purchased_at = null where id = $1", [id]);
      const checking = passagePurchasePort({ db: kit.db, queue: kit.queue, clock: kit.clock }).check(chatId, "late@mail.ru");
      await new Promise((resolve) => setTimeout(resolve, 300));
      await refund.query("commit");
      expect((await checking).kind).not.toBe("paid");
    } finally {
      refund.release();
    }
    expect((await passage()).purchasedAt).toBeNull();
  });

  it("возврат, обработанный пока модель писала поздравление, поздравление отменяет", async () => {
    await start();
    await say("Дайте ссылку на курс");
    const { id, trackingCode } = await passage();
    const orderId = `gc-${randomUUID().slice(0, 6)}`;
    await notify({ event: "order_paid", id: orderId, status: "Завершён", utm_content: trackingCode });
    const writer = {
      writeFirst: async () => {
        await notify({ event: "order_refunded", id: orderId, status: "Возврат", utm_content: trackingCode });
        return { kind: "answer" as const, text: "Поздравляю, курс ваш!", video: null, image: null };
      },
    };
    await reactions.congratulatePurchase({ db: kit.db, queue: kit.queue, clock: kit.clock, writer }, id);
    expect((await outboundOf(kit)).filter((row) => row.passageId === id && row.text === "Поздравляю, курс ваш!")).toHaveLength(0);
    expect((await passage()).purchaseCongratulatedAt).toBeNull();
  });

  it("возврат, обработанный между проверкой покупки и записью поздравления, поздравление отменяет", async () => {
    await start();
    await say("Дайте ссылку на курс");
    const { id, trackingCode } = await passage();
    await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", utm_content: trackingCode });
    const writer = { writeFirst: async () => ({ kind: "answer" as const, text: "Поздравляю, курс ваш!", video: null, image: null }) };

    // Реакция на возврат держит прохождение: возврат записан, покупка снята, фиксируется посреди записи поздравления
    const refund = await database.pool.connect();
    try {
      await refund.query("begin");
      await refund.query("select id from app.passages where id = $1 for update", [id]);
      await refund.query("update app.product_orders set refunded_at = now(), status = 'Возврат' where passage_id = $1", [id]);
      await refund.query("update app.passages set purchased_at = null where id = $1", [id]);
      const congratulating = reactions.congratulatePurchase({ db: kit.db, queue: kit.queue, clock: kit.clock, writer }, id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await refund.query("commit");
      await congratulating;
    } finally {
      refund.release();
    }
    expect((await outboundOf(kit)).filter((row) => row.passageId === id && row.text === "Поздравляю, курс ваш!")).toHaveLength(0);
    expect((await passage()).purchaseCongratulatedAt).toBeNull();
  });

  it("поздравление записано, а задача отправки не поставилась: подмётчик исходящих его отправит, второго не будет", async () => {
    await start();
    await say("Дайте ссылку на курс");
    const { id, trackingCode } = await passage();
    await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", utm_content: trackingCode });
    const writer = { writeFirst: async () => ({ kind: "answer" as const, text: "Поздравляю, курс ваш!", video: null, image: null }) };
    const deps = { db: kit.db, queue: kit.queue, clock: kit.clock, writer };
    kit.queue.failNext();
    await expect(reactions.congratulatePurchase(deps, id)).rejects.toThrow("Очередь недоступна");
    expect((await passage()).purchaseCongratulatedAt).not.toBeNull();
    const congratulation = async () => (await outboundOf(kit)).filter((row) => row.passageId === id && row.text === "Поздравляю, курс ваш!");
    expect((await congratulation()).map((row) => row.status)).toEqual(["queued"]);

    await reactions.congratulatePurchase(deps, id);
    kit.clock.advance(10 * 60_000);
    await requeueStuckOutbound({ db: kit.db, queue: kit.queue }, new Date(kit.clock.now().getTime() - 5 * 60_000));
    await kit.drain();
    expect((await congratulation()).map((row) => row.status)).toEqual(["sent"]);
    expect(kit.textsTo(person).filter((text) => text === "Поздравляю, курс ваш!")).toHaveLength(1);
  });

  it("оплата, обработанная пока модель писала напоминание, напоминание отменяет", async () => {
    await start();
    await say("Дайте ссылку на курс");
    await say("Беру курс");
    const { id, trackingCode } = await passage();
    const writer = {
      writeFirst: async () => {
        await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", utm_content: trackingCode });
        return { kind: "answer" as const, text: "Напоминаю про курс", video: null, image: null };
      },
    };
    await remindPayment({ db: kit.db, queue: kit.queue, clock: kit.clock, writer }, id);
    expect((await passage()).purchasedAt).not.toBeNull();
    expect((await outboundOf(kit)).filter((row) => row.passageId === id && row.text === "Напоминаю про курс")).toHaveLength(0);
    expect((await passage()).paymentReminderSentAt).toBeNull();
  });

  it("напоминание записано, а задача отправки не поставилась: подмётчик исходящих его отправит, второго не будет", async () => {
    await start();
    await say("Беру курс");
    const { id } = await passage();
    const writer = { writeFirst: async () => ({ kind: "answer" as const, text: "Напоминаю про курс", video: null, image: null }) };
    const deps = { db: kit.db, queue: kit.queue, clock: kit.clock, writer };
    kit.queue.failNext();
    await expect(remindPayment(deps, id)).rejects.toThrow("Очередь недоступна");
    expect((await passage()).paymentReminderSentAt).not.toBeNull();
    const reminder = async () => (await outboundOf(kit)).filter((row) => row.passageId === id && row.text === "Напоминаю про курс");
    expect((await reminder()).map((row) => row.status)).toEqual(["queued"]);

    await remindPayment(deps, id);
    kit.clock.advance(10 * 60_000);
    await requeueStuckOutbound({ db: kit.db, queue: kit.queue }, new Date(kit.clock.now().getTime() - 5 * 60_000));
    await kit.drain();
    expect((await reminder()).map((row) => row.status)).toEqual(["sent"]);
  });

  it("неоплаченный заказ привязан сверкой по почте — назавтра одно напоминание", async () => {
    await start();
    await notify({ event: "order_created", id: `gc-${randomUUID().slice(0, 6)}`, status: "Новый", email: "open5@mail.ru" });
    expect(kit.queue.count("payment-reminder")).toBe(0);
    await say("Я оплатил с open5@mail.ru");
    expect(kit.queue.count("payment-reminder")).toBe(1);
    // Повторная сверка второго напоминания не ставит
    await say("Я оплатил с open5@mail.ru");
    expect(kit.queue.count("payment-reminder")).toBe(1);
  });

  it("запасной путь по почте: последнее бесплатное прохождение и чужой продукт не перехватывают оплату", async () => {
    const course = await start();
    const coursePassage = await passage();
    const personId = (await kit.personOf(person))!.id;
    await kit.db.update(people).set({ fieldValues: { email: "both@mail.ru" } }).where(eq(people.id, personId));
    const free = await kit.publish({ instruction: SETTINGS.instruction });
    await kit.send(person, `/start ${free.code}`, { startCode: free.code });
    await kit.runDue();
    const freePassage = (await kit.passagesOf(person)).find((row) => row.leadMagnetId === free.leadMagnetId)!;
    expect(freePassage.startedAt.getTime()).toBeGreaterThanOrEqual(coursePassage.startedAt.getTime());
    expect(course.leadMagnetId).not.toBe(free.leadMagnetId);

    const plain = `gc-${randomUUID().slice(0, 6)}`;
    await notify({ event: "order_paid", id: plain, status: "Завершён", email: "both@mail.ru" });
    const [order] = await kit.db.select().from(productOrders).where(eq(productOrders.externalOrderId, plain));
    expect(order).toMatchObject({ passageId: coursePassage.id, matchedBy: "email" });

    const foreign = `gc-${randomUUID().slice(0, 6)}`;
    await notify({ event: "order_paid", id: foreign, status: "Завершён", email: "both@mail.ru", utm_campaign: "other_course" });
    const [other] = await kit.db.select().from(productOrders).where(eq(productOrders.externalOrderId, foreign));
    expect(other?.passageId).toBeNull();
  });

  it("модель упала после payment_check «оплата есть»: поздравление не теряется и уходит один раз", async () => {
    await start();
    await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", email: "pay2@mail.ru" });
    // Провайдер лежит, пока человек ждёт ответа: и ход, и его быстрые повторы падают после результата проверки
    let down = true;
    let failed = false;
    kit.reply = (call) => {
      if (down && call.lastToolResult !== undefined && JSON.stringify(call.lastToolResult).includes("Оплата есть")) {
        failed = true;
        throw providerOutage();
      }
      return scripted(call);
    };
    await say("Я оплатил с pay2@mail.ru");
    expect(failed).toBe(true);
    expect((await passage()).purchaseCongratulatedAt).toBeNull();
    down = false;

    await kit.drain();
    const congratulations = kit.textsTo(person).filter((text) => /поздравля/i.test(text));
    expect(congratulations).toHaveLength(1);
    expect((await passage()).purchaseCongratulatedAt).not.toBeNull();
  });

  it("ответ хода с найденной оплатой записан, а отметки нет (упал между ними): запасная задача второго поздравления не пишет", async () => {
    await start();
    await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", email: "pay3@mail.ru" });
    const { id: passageId } = await passage();
    // Пометка «отвечено» этого прохождения падает: ответ уже в исходящих, транзакция с отметкой не прошла
    const crash = `crash_${randomUUID().slice(0, 8)}`;
    await database.pool.query(`create function app.${crash}() returns trigger language plpgsql as $$ begin raise exception 'упал после записи ответа'; end $$`);
    await database.pool.query(
      `create trigger ${crash} before update of answered_at on app.inbound_messages for each row
       when (new.passage_id = '${passageId}' and new.answered_at is not null) execute function app.${crash}()`,
    );
    try {
      await say("Я оплатил с pay3@mail.ru");
    } catch {
      // Работник упал вместе с ходом
    } finally {
      await database.pool.query(`drop trigger ${crash} on app.inbound_messages; drop function app.${crash}()`);
    }
    const congratulations = async () => (await outboundOf(kit)).filter((row) => row.passageId === passageId && /поздравля/i.test(row.text)).map((row) => row.text);
    expect(await congratulations()).toEqual(["Вижу оплату — поздравляю!"]);
    expect((await passage()).purchaseCongratulatedAt).toBeNull();

    await kit.drain();
    expect(await congratulations()).toEqual(["Вижу оплату — поздравляю!"]);
    expect((await passage()).purchaseCongratulatedAt).not.toBeNull();
  });

  /** Уведомление записано, а реакция ещё не исполнена (процесс медленный или упал после записи). */
  const recordOnly = (body: Record<string, unknown>) =>
    recordOrderNotice({ db: kit.db, clock: kit.clock }, "getcourse", parseGetCourseNotice(body)!, body);

  it("запоздалая реакция на оплату после уже обработанного возврата покупку не возвращает", async () => {
    await start();
    await say("Дайте ссылку на курс");
    const { trackingCode } = await passage();
    const orderId = `gc-${randomUUID().slice(0, 6)}`;
    const paid = await recordOnly({ event: "order_paid", id: orderId, status: "Завершён", utm_content: trackingCode });
    kit.clock.advance(1_000);
    await notify({ event: "order_refunded", id: orderId, status: "Возврат", utm_content: trackingCode });
    await reactions.reactToOrder({ db: kit.db, queue: kit.queue, clock: kit.clock }, paid);
    await kit.drain();

    expect((await passage()).purchasedAt).toBeNull();
    expect(await firstMessagesToPerson()).toEqual([]);
  });

  it("реакция на «создан» исполняется после записанной следом оплаты: оплата не теряется, метка чужой реакции не снята вслепую", async () => {
    await start();
    await say("Дайте ссылку на курс");
    const { trackingCode } = await passage();
    const orderId = `gc-${randomUUID().slice(0, 6)}`;
    // Часы стоят: обе метки — в одну миллисекунду
    const created = await recordOnly({ event: "order_created", id: orderId, status: "Новый", utm_content: trackingCode });
    await recordOnly({ event: "order_paid", id: orderId, status: "Завершён", utm_content: trackingCode });
    await reactions.reactToOrder({ db: kit.db, queue: kit.queue, clock: kit.clock }, created);
    await kit.drain();

    expect((await passage()).purchasedAt).not.toBeNull();
    expect(await firstMessagesToPerson()).toEqual(["Поздравляю с покупкой курса! 🎉"]);
  });

  it("finish_dialog после оплаты не перетирает итог купившего: остаётся «согласился»", async () => {
    await start();
    await say("Дайте ссылку на курс");
    const { trackingCode, chatId } = await passage();
    await notify({ event: "order_paid", id: `gc-${randomUUID().slice(0, 6)}`, status: "Завершён", utm_content: trackingCode });
    await createPassageConversationStore(kit.db, kit.clock).finish(chatId, { goal: "Цель", stuckAt: "Застрял", chosenStep: "Шаг", outcome: "declined" });
    expect((await passage()).summary?.outcome).toBe("agreed");
  });
});
