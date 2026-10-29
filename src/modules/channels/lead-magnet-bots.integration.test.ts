import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLeadMagnet } from "../lead-magnets";
import { bots, leadMagnetBots } from "./schema";

let database: TestDatabase;
let counter = 0;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

async function insertBot(defaultLeadMagnetId: string | null = null) {
  const [bot] = await database.db
    .insert(bots)
    .values({
      channel: "telegram",
      title: "Бот",
      externalId: `bot-${++counter}`,
      username: `bot_${counter}`,
      tokenEncrypted: "x",
      webhookSecret: "s",
      defaultLeadMagnetId,
    })
    .returning();
  return bot!;
}

/** Ошибка базы из drizzle лежит в cause: достаём код Postgres. */
async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code ?? (error as { code?: string }).code;
  }
  return undefined;
}

describe("лидмагнит и боты", () => {
  it("на один мессенджер у лидмагнита не больше одного бота", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Два бота" });
    const first = await insertBot();
    const second = await insertBot();
    await database.db.insert(leadMagnetBots).values({ leadMagnetId: lead.id, botId: first.id, channel: "telegram" });
    expect(
      await pgErrorCode(database.db.insert(leadMagnetBots).values({ leadMagnetId: lead.id, botId: second.id, channel: "telegram" })),
    ).toBe("23505");
  });

  it("связь только с существующими лидмагнитом и ботом", async () => {
    const bot = await insertBot();
    const missing = "00000000-0000-4000-8000-000000000000";
    expect(
      await pgErrorCode(database.db.insert(leadMagnetBots).values({ leadMagnetId: missing, botId: bot.id, channel: "telegram" })),
    ).toBe("23503");
  });

  it("лидмагнит по умолчанию у бота — только существующий", async () => {
    expect(await pgErrorCode(insertBot("00000000-0000-4000-8000-000000000000"))).toBe("23503");
    const lead = await createLeadMagnet(database.db, { name: "По умолчанию" });
    const bot = await insertBot(lead.id);
    const [row] = await database.db.select().from(bots).where(eq(bots.id, bot.id));
    expect(row!.defaultLeadMagnetId).toBe(lead.id);
  });
});
