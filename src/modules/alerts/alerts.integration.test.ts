import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createFakeClock, type FakeClock } from "../platform/clock";
import { updateSettings } from "../platform/settings";
import { createAlerts, type AlertNotifier } from "./index";
import { createTelegramNotifier } from "./telegram-notifier";

let database: TestDatabase;
let clock: FakeClock;
let sent: Array<{ chatId: string; text: string }>;
let failNextSend: boolean;

const notifier: AlertNotifier = {
  async send(chatId, text) {
    if (failNextSend) {
      failNextSend = false;
      throw new Error("Telegram не отвечает");
    }
    sent.push({ chatId, text });
  },
};

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query("delete from app.alerts");
  await updateSettings(database.db, { alertChatId: "777" });
  clock = createFakeClock(new Date("2026-10-10T09:00:00Z"));
  sent = [];
  failNextSend = false;
});

const alerts = () => createAlerts({ db: database.db, clock, notifier });

describe("тревоги", () => {
  it("первая тревога уходит в чат из настроек", async () => {
    expect(await alerts().raise("budget_50", "Потрачено 50%")).toEqual({ status: "sent" });
    expect(sent).toEqual([{ chatId: "777", text: "Потрачено 50%" }]);
  });

  it("50% и 80% — по одному разу в месяц", async () => {
    const service = alerts();
    await service.raise("budget_50", "50%");
    clock.advance(3 * 24 * 3600_000);
    expect(await service.raise("budget_50", "50% ещё раз")).toEqual({ status: "suppressed" });
    await service.raise("budget_80", "80%");
    expect(await service.raise("budget_80", "80% ещё раз")).toEqual({ status: "suppressed" });
    expect(sent.map((message) => message.text)).toEqual(["50%", "80%"]);
  });

  it("в новом месяце по Москве тревога снова уходит", async () => {
    const service = alerts();
    clock.set(new Date("2026-10-31T20:00:00Z")); // 23:00 31 октября по Москве
    await service.raise("budget_50", "октябрь");
    clock.set(new Date("2026-10-31T21:30:00Z")); // 00:30 1 ноября по Москве
    expect(await service.raise("budget_50", "ноябрь")).toEqual({ status: "sent" });
    expect(sent.map((message) => message.text)).toEqual(["октябрь", "ноябрь"]);
  });

  it("100% повторяется раз в час, пока эксперт не нажал «вижу»", async () => {
    const service = alerts();
    await service.raise("budget_100", "100%");
    clock.advance(30 * 60_000);
    expect(await service.raise("budget_100", "100%")).toEqual({ status: "suppressed" });
    clock.advance(31 * 60_000);
    expect(await service.raise("budget_100", "100%")).toEqual({ status: "sent" });
    expect(sent).toHaveLength(2);
  });

  it("после «вижу» 100% больше не повторяется", async () => {
    const service = alerts();
    await service.raise("budget_100", "100%");
    await service.acknowledge("budget_100");
    clock.advance(5 * 3600_000);
    expect(await service.raise("budget_100", "100%")).toEqual({ status: "suppressed" });
    expect(sent).toHaveLength(1);
  });

  it("ошибка бота приходит один раз, без повторов", async () => {
    const service = alerts();
    await service.raise("bot_error", "Бот не отвечает", "bot-1");
    clock.advance(24 * 3600_000);
    expect(await service.raise("bot_error", "Бот не отвечает", "bot-1")).toEqual({ status: "suppressed" });
  });

  it("тревоги про разных ботов не мешают друг другу", async () => {
    const service = alerts();
    await service.raise("bot_error", "Бот 1", "bot-1");
    expect(await service.raise("bot_error", "Бот 2", "bot-2")).toEqual({ status: "sent" });
  });

  it("после resolve та же тревога может прийти снова", async () => {
    const service = alerts();
    await service.raise("bot_error", "сломался", "bot-1");
    await service.resolve("bot_error", "bot-1");
    expect(await service.raise("bot_error", "сломался снова", "bot-1")).toEqual({ status: "sent" });
  });

  it("при сбое отправки тревога не считается отправленной и уходит при следующей попытке", async () => {
    const service = alerts();
    failNextSend = true;
    expect(await service.raise("budget_80", "80%")).toEqual({ status: "failed", error: "Telegram не отвечает" });
    expect((await database.pool.query("select 1 from app.alerts")).rowCount).toBe(0);
    expect(await service.raise("budget_80", "80%")).toEqual({ status: "sent" });
  });

  it("две одновременные проверки шлют тревогу один раз", async () => {
    // Медленная отправка: обе проверки успевают начаться до того, как первая закончит
    const slow: AlertNotifier = {
      async send(chatId, text) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        sent.push({ chatId, text });
      },
    };
    const first = createAlerts({ db: database.db, clock, notifier: slow });
    const second = createAlerts({ db: database.db, clock, notifier: slow });
    const results = await Promise.all([first.raise("budget_50", "50%"), second.raise("budget_50", "50%")]);
    expect(sent).toHaveLength(1);
    expect(results.map((result) => result.status).sort()).toEqual(["sent", "suppressed"]);
  });

  it("одновременный повтор 100% через час — тоже один", async () => {
    const service = alerts();
    await service.raise("budget_100", "100%");
    clock.advance(61 * 60_000);
    const slow: AlertNotifier = {
      async send(chatId, text) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        sent.push({ chatId, text });
      },
    };
    const both = [createAlerts({ db: database.db, clock, notifier: slow }), createAlerts({ db: database.db, clock, notifier: slow })];
    await Promise.all(both.map((one) => one.raise("budget_100", "100%")));
    expect(sent).toHaveLength(2);
  });

  it("сбой отправки повтора не сдвигает час: следующая проверка шлёт сразу", async () => {
    const service = alerts();
    await service.raise("budget_100", "100%");
    clock.advance(61 * 60_000);
    failNextSend = true;
    expect((await service.raise("budget_100", "100%")).status).toBe("failed");
    expect(await service.raise("budget_100", "100%")).toEqual({ status: "sent" });
    expect(sent).toHaveLength(2);
  });

  it("чат для тревог не задан — это сбой, а не тишина", async () => {
    await updateSettings(database.db, { alertChatId: null });
    const result = await alerts().raise("budget_50", "50%");
    expect(result.status).toBe("failed");
    expect(sent).toHaveLength(0);
  });
});

describe("отправка тревог через Telegram", () => {
  it("вызывает sendMessage у бота тревог", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const telegram = createTelegramNotifier({
      token: "123:abc",
      apiBaseUrl: "https://tg.example/",
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: true, result: {} });
      },
    });
    await telegram.send("777", "Привет");
    expect(calls).toEqual([
      { url: "https://tg.example/bot123:abc/sendMessage", body: { chat_id: "777", text: "Привет" } },
    ]);
  });

  it("ошибка Telegram поднимается наверх без токена в тексте", async () => {
    const telegram = createTelegramNotifier({
      token: "123:abc",
      fetch: async () => Response.json({ ok: false, description: "Bad Request: chat not found" }, { status: 400 }),
    });
    const error = await telegram.send("777", "Привет").catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("chat not found");
    expect((error as Error).message).not.toContain("123:abc");
  });
});
