import { and, eq } from "drizzle-orm";
import type { TokenCipher } from "../platform/crypto";
import type { Database } from "../platform/db";
import { createWebChatVisitor } from "../web-chat";
import { chatApiVisitors } from "./schema";

/** Самый длинный id посетителя, который сервер эксперта может назвать. */
export const SERVER_VISITOR_ID_MAX_LENGTH = 200;

class LostRace extends Error {}

/**
 * Токен посетителя веб-чата для посетителя сервера эксперта (`externalId` — его id на стороне эксперта). Не заводили —
 * `null`, а с `create` — новый посетитель. Одновременные первые запросы одного посетителя заводят одного: проигравший
 * откатывает своего и берёт записанного.
 */
export async function serverVisitorToken(
  deps: { db: Database; cipher: TokenCipher },
  input: { leadMagnetId: string; externalId: string; code: string },
  options: { create: boolean },
): Promise<string | null> {
  const known = await knownToken(deps, input);
  if (known || !options.create) return known;
  try {
    return await deps.db.transaction(async (tx) => {
      const { visitor, token } = await createWebChatVisitor(tx, input.code);
      const saved = await tx
        .insert(chatApiVisitors)
        .values({ leadMagnetId: input.leadMagnetId, externalId: input.externalId, visitorId: visitor.id, tokenEncrypted: deps.cipher.encrypt(token) })
        .onConflictDoNothing()
        .returning({ visitorId: chatApiVisitors.visitorId });
      if (saved.length === 0) throw new LostRace();
      return token;
    });
  } catch (error) {
    if (error instanceof LostRace) return knownToken(deps, input);
    throw error;
  }
}

async function knownToken(deps: { db: Database; cipher: TokenCipher }, input: { leadMagnetId: string; externalId: string }): Promise<string | null> {
  const [row] = await deps.db
    .select({ tokenEncrypted: chatApiVisitors.tokenEncrypted })
    .from(chatApiVisitors)
    .where(and(eq(chatApiVisitors.leadMagnetId, input.leadMagnetId), eq(chatApiVisitors.externalId, input.externalId)));
  return row ? deps.cipher.decrypt(row.tokenEncrypted) : null;
}
