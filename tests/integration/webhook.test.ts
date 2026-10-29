import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inboundMessages } from "@/modules/conversations/schema";
import { createTestDatabase, type TestDatabase } from "./db-helper";
import { DEFAULT_CONSULTANT_REPLY, createLiveDialogKit, type LiveDialogKit } from "./live-dialog-kit";

let database: TestDatabase;
let kit: LiveDialogKit;
let code: string;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database);
  ({ code } = await kit.publish());
});

const userId = () => `user-${randomUUID().slice(0, 8)}`;

describe("вебхук", () => {
  it("отвечает сразу: только запись и задача inbound-route, без модели и без мессенджера", async () => {
    const person = userId();
    const response = await kit.send(person, `/start ${code}`, { startCode: code });

    expect(response.status).toBe(200);
    expect(kit.queue.count("inbound-route")).toBe(1);
    expect(kit.calls).toHaveLength(0);
    expect(kit.channel.attempts).toHaveLength(0);
    expect(await kit.inboundOf(person)).toHaveLength(1);
  });

  it("повтор того же update_id — одна запись и один ответ", async () => {
    const person = userId();
    await kit.send(person, `/start ${code}`, { startCode: code });
    await kit.drain();
    const firstMessages = kit.textsTo(person).length;

    const dedupeKey = `telegram:${kit.bot.id}:777`;
    expect((await kit.send(person, "Я дизайнер", { dedupeKey })).status).toBe(200);
    expect((await kit.send(person, "Я дизайнер", { dedupeKey })).status).toBe(200);
    await kit.drain();

    expect((await kit.inboundOf(person)).filter((row) => row.dedupeKey === dedupeKey)).toHaveLength(1);
    expect(kit.calls).toHaveLength(1);
    expect(kit.textsTo(person).slice(firstMessages)).toEqual([DEFAULT_CONSULTANT_REPLY]);
  });

  it("неверный секрет — 401, ничего не записано и не поставлено", async () => {
    const person = userId();
    const response = await kit.webhook(
      [{ type: "message", dedupeKey: `telegram:${kit.bot.id}:1`, userId: person, text: "Привет" }],
      "чужой-секрет",
    );

    expect(response.status).toBe(401);
    expect(await kit.inboundOf(person)).toHaveLength(0);
    expect(kit.queue.history).toHaveLength(0);
  });

  it("неизвестный бот или чужой мессенджер — 401 без подробностей", async () => {
    const request = kit.channel.webhookRequest(kit.bot, [
      { type: "message", dedupeKey: "x", userId: userId(), text: "Привет" },
    ]);
    const unknownBot = await kit.dialog.acceptWebhook({ channel: "telegram", botId: randomUUID(), request });
    const wrongChannel = await kit.dialog.acceptWebhook({ channel: "vk", botId: kit.bot.id, request });
    const notUuid = await kit.dialog.acceptWebhook({ channel: "telegram", botId: "not-a-uuid", request });

    for (const response of [unknownBot, wrongChannel, notUuid]) {
      expect(response.status).toBe(401);
      expect(response.body).toBe("");
    }
  });

  it("очередь недоступна — 500 и записи нет: мессенджер повторит, и сообщение не потеряется", async () => {
    const person = userId();
    kit.queue.failNext();
    const failed = await kit.send(person, `/start ${code}`, { startCode: code, dedupeKey: "retry-me" });
    expect(failed.status).toBe(500);
    expect(await kit.inboundOf(person)).toHaveLength(0);

    const retried = await kit.send(person, `/start ${code}`, { startCode: code, dedupeKey: "retry-me" });
    expect(retried.status).toBe(200);
    await kit.drain();
    expect(kit.textsTo(person)).toHaveLength(1);
  });

  it("процесс упал между записью и задачей — повтор вебхука ставит задачу заново, но только пока запись не разобрана", async () => {
    const person = userId();
    const dedupeKey = `crash-${person}`;
    // Строка записана, задача не поставлена: процесс упал, мессенджер не получил ответа и повторит
    await database.db
      .insert(inboundMessages)
      .values({ botId: kit.bot.id, kind: "message", dedupeKey, externalUserId: person, text: `/start ${code}`, startCode: code });

    const retried = await kit.send(person, `/start ${code}`, { startCode: code, dedupeKey });
    expect(retried.status).toBe(200);
    expect(kit.queue.count("inbound-route")).toBe(1);
    await kit.drain();
    expect(kit.textsTo(person)).toHaveLength(1);

    // Запись разобрана — следующий повтор задачу не ставит
    await kit.send(person, `/start ${code}`, { startCode: code, dedupeKey });
    expect(kit.queue.count("inbound-route")).toBe(1);
    expect(await kit.inboundOf(person)).toHaveLength(1);
  });

  it("несколько событий в одном запросе — каждое своей записью", async () => {
    const person = userId();
    await kit.webhook([
      { type: "message", dedupeKey: `${person}-a`, userId: person, text: "Раз" },
      { type: "message", dedupeKey: `${person}-b`, userId: person, text: "Два" },
    ]);
    const rows = await database.db.select().from(inboundMessages);
    expect(rows.filter((row) => row.externalUserId === person).map((row) => row.text).sort()).toEqual(["Два", "Раз"]);
    expect(kit.queue.count("inbound-route")).toBe(2);
  });
});
