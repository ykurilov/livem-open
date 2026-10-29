import type { FlowPeople } from "@ykurilov/agent-chat-flows";
import { desc, eq, isNotNull, sql } from "drizzle-orm";
import { previewConversations } from "../consultant/schema";
import { leadMagnets } from "../lead-magnets/schema";
import { people } from "../people/schema";
import { isPreviewOwner } from "../platform/cabinet-owner";
import type { Database } from "../platform/db";

/** Тестовые разговоры, открытые сейчас в «Проверке». */
const currentPreviews = sql`${previewConversations.chatId} in (select ${leadMagnets.previewChatId} from ${leadMagnets} where ${leadMagnets.previewChatId} is not null)`;

/**
 * Пояс человека для сценария: один на все его разговоры, в `people.time_zone`. Узнаёт его SDK (`flow_time_zone`).
 * У тестовых чатов эксперта — в тестовом разговоре: «Проверка» не трогает «Базу».
 */
export function leadMagnetPeople(db: Database): FlowPeople {
  return {
    async readTimeZone(ownerId) {
      if (isPreviewOwner(ownerId)) {
        const [row] = await db
          .select({ timeZone: previewConversations.timeZone })
          .from(previewConversations)
          .where(sql`${currentPreviews} and ${isNotNull(previewConversations.timeZone)}`)
          .orderBy(desc(previewConversations.createdAt))
          .limit(1);
        return row?.timeZone ?? null;
      }
      const [row] = await db.select({ timeZone: people.timeZone }).from(people).where(eq(people.id, ownerId));
      return row?.timeZone ?? null;
    },

    async writeTimeZone(ownerId, timeZone) {
      if (isPreviewOwner(ownerId)) {
        await db.update(previewConversations).set({ timeZone }).where(currentPreviews);
        return;
      }
      await db.update(people).set({ timeZone }).where(eq(people.id, ownerId));
    },
  };
}
