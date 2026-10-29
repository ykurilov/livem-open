import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { eq } from "drizzle-orm";
import { createLeadMagnet, getLeadMagnet } from "../lead-magnets";
import { leadMagnets } from "../lead-magnets/schema";
import { startPreviewConversation } from "../consultant/preview-store";
import { createShortLinkStore } from "./short-link-store";

let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database.drop();
});

const template = "https://appstudio.example.com/?idea={text}&type={type}";
const target = "https://appstudio.example.com/?idea=%D0%9A%D0%BE%D1%82&type=game";

describe("хранилище коротких ссылок", () => {
  it("короткая ссылка — адрес приложения /i/<код>; полная хранится у нас и находится по коду", async () => {
    const store = createShortLinkStore(database.db, "https://lm.example.ru/");
    const short = await store.shorten({ chatId: "chat-a", template, target });
    expect(short).toMatch(/^https:\/\/lm\.example\.ru\/i\/[A-Za-z0-9]{7}$/);
    expect(await store.lookup(short.split("/i/")[1]!)).toEqual({ target, template });
    expect(await store.lookup("Zz9Zz9Z")).toBeNull();
  });

  it("тот же текст и тип в одном разговоре — тот же код; в другом разговоре — другой", async () => {
    const store = createShortLinkStore(database.db, "https://lm.example.ru");
    const first = await store.shorten({ chatId: "chat-b", template, target });
    expect(await store.shorten({ chatId: "chat-b", template, target })).toBe(first);
    expect(await store.shorten({ chatId: "chat-c", template, target })).not.toBe(first);
  });

  it("тестовый разговор «Проверки» — лидмагнит записан; сервисы для страницы «устарела» — из шаблонов", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Первое приложение" });
    const draft = (await getLeadMagnet(database.db, lead.id))!.draft;
    await database.db.update(leadMagnets).set({ draft: { ...draft, textLink: { template, types: ["game"], maxTextLength: 1200 } } }).where(eq(leadMagnets.id, lead.id));
    await startPreviewConversation(database.db, { chatId: "preview-1", leadMagnetId: lead.id });
    const store = createShortLinkStore(database.db, "https://lm.example.ru");
    await store.shorten({ chatId: "preview-1", template, target });
    expect(await store.leadMagnetOf("preview-1")).toBe(lead.id);
    expect(await store.services()).toContain("https://appstudio.example.com/");
  });
});
