import { factId, type ClientCardEntry, type ClientCardStore, type ClientFact, type ClientFactStore } from "@ykurilov/agent-chat-flows";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { previewConversations } from "../consultant/schema";
import { passages } from "../conversations/schema";
import { leadMagnets } from "../lead-magnets/schema";
import { getFields, isValidFieldValue, type PersonFact, type PersonFieldValue } from "../people";
import { people } from "../people/schema";
import { isPreviewOwner } from "../platform/cabinet-owner";
import type { Database } from "../platform/db";

// Карточка клиента сценария (plan.md, раздел 2.1): поля — в «Базе» (`people.field_values`), свободные факты — отдельно
// (`people.facts`): на полях строятся фильтры и рассылки, факты с ними не смешиваются. Тестовый чат эксперта пишет в
// свой тестовый разговор (`preview_conversations`), а не в «Базу». Id факта — `factId` SDK: факты, записанные до
// сценариев, получают id по нему же.

const idOf = (fact: Pick<PersonFact, "id" | "text">) => fact.id ?? factId(fact.text);

/** Тестовые разговоры эксперта, которые сейчас открыты в «Проверке»: у владельцев тестовых чатов одна карточка на них. */
const currentPreviews = sql`${previewConversations.chatId} in (select ${leadMagnets.previewChatId} from ${leadMagnets} where ${leadMagnets.previewChatId} is not null)`;

/** Поле можно записать, только если оно есть в словаре и значение подходит по типу; иначе агент услышит причину. */
async function checkedValue(db: Database, fieldId: string, value: unknown): Promise<PersonFieldValue> {
  const [field] = await getFields(db, [fieldId]);
  if (!field) throw new Error(`Поля «${fieldId}» нет в «Базе» (его удалили): не записано. Сохрани сведение фактом.`);
  if (!isValidFieldValue(field, value)) throw new Error(`Поле «${field.name}» не подходит под это значение: не записано.`);
  return value as PersonFieldValue;
}

function previewFacts(db: Database): ClientFactStore {
  return {
    async read() {
      const rows = await db
        .select({ chatId: previewConversations.chatId, leadMagnetId: previewConversations.leadMagnetId, facts: previewConversations.facts, at: previewConversations.createdAt })
        .from(previewConversations)
        .where(currentPreviews);
      return rows.flatMap((row) =>
        row.facts.map((text) => ({ id: factId(text), text, updatedAt: row.at.toISOString(), chatId: row.chatId, flowId: row.leadMagnetId })),
      );
    },
    async add({ fact, chatId }) {
      await db.transaction(async (tx) => {
        const [row] = await tx.select({ facts: previewConversations.facts }).from(previewConversations).where(eq(previewConversations.chatId, chatId)).for("update");
        if (!row || row.facts.some((text) => factId(text) === fact.id)) return;
        await tx.update(previewConversations).set({ facts: [...row.facts, fact.text] }).where(eq(previewConversations.chatId, chatId));
      });
    },
    async forget(_ownerId, id) {
      const rows = await db.select({ chatId: previewConversations.chatId, facts: previewConversations.facts }).from(previewConversations).where(currentPreviews);
      for (const row of rows) {
        const facts = id === "all" ? [] : row.facts.filter((text) => factId(text) !== id);
        if (facts.length !== row.facts.length) await db.update(previewConversations).set({ facts }).where(eq(previewConversations.chatId, row.chatId));
      }
    },
  };
}

function personFacts(db: Database): ClientFactStore {
  return {
    async read(ownerId) {
      const [row] = await db.select({ facts: people.facts }).from(people).where(eq(people.id, ownerId));
      return (row?.facts ?? []).map(
        (fact): ClientFact => ({ id: idOf(fact), text: fact.text, updatedAt: fact.at, chatId: fact.chatId ?? "", flowId: fact.flowId ?? "" }),
      );
    },
    async add({ ownerId, fact, chatId, flowId, at }) {
      await db.transaction(async (tx) => {
        const [row] = await tx.select({ facts: people.facts }).from(people).where(eq(people.id, ownerId)).for("update");
        if (!row || row.facts.some((known) => idOf(known) === fact.id)) return;
        const [passage] = await tx.select({ id: passages.id }).from(passages).where(eq(passages.chatId, chatId));
        const added: PersonFact = { id: fact.id, text: fact.text, at: at.toISOString(), source: passage?.id ?? chatId, chatId, flowId };
        await tx.update(people).set({ facts: [...row.facts, added] }).where(eq(people.id, ownerId));
      });
    },
    async forget(ownerId, id) {
      await db.transaction(async (tx) => {
        const [row] = await tx.select({ facts: people.facts }).from(people).where(eq(people.id, ownerId)).for("update");
        if (!row) return;
        const facts = id === "all" ? [] : row.facts.filter((fact) => idOf(fact) !== id);
        if (facts.length !== row.facts.length) await tx.update(people).set({ facts }).where(eq(people.id, ownerId));
      });
    },
  };
}

/** Карточка клиента сценария в «Базе»: `createAgentFlow({ clientCard: leadMagnetClientCard(db), clientFacts: true })`. */
export function leadMagnetClientCard(db: Database): ClientCardStore {
  const people_ = personFacts(db);
  const preview = previewFacts(db);
  return {
    async read(ownerId) {
      if (isPreviewOwner(ownerId)) {
        const rows = await db
          .select({ chatId: previewConversations.chatId, leadMagnetId: previewConversations.leadMagnetId, values: previewConversations.fieldValues, at: previewConversations.createdAt })
          .from(previewConversations)
          .where(currentPreviews);
        return rows.flatMap((row) => entriesOf(row.values, row.at, row.chatId, row.leadMagnetId));
      }
      const [row] = await db.select({ values: people.fieldValues, at: people.createdAt }).from(people).where(eq(people.id, ownerId));
      return row ? entriesOf(row.values, row.at, "", "") : [];
    },

    async write({ ownerId, fieldId, value, chatId }) {
      const checked = await checkedValue(db, fieldId, value);
      const patch = JSON.stringify({ [fieldId]: checked });
      if (isPreviewOwner(ownerId)) {
        await db
          .update(previewConversations)
          .set({ fieldValues: sql`${previewConversations.fieldValues} || ${patch}::jsonb` })
          .where(eq(previewConversations.chatId, chatId));
        return;
      }
      await db
        .update(people)
        .set({ fieldValues: sql`${people.fieldValues} || ${patch}::jsonb` })
        .where(eq(people.id, ownerId));
    },

    async forget(ownerId, fieldId) {
      const cleared = fieldId === "all" ? sql`'{}'::jsonb` : null;
      if (isPreviewOwner(ownerId)) {
        await db
          .update(previewConversations)
          .set({ fieldValues: cleared ?? sql`${previewConversations.fieldValues} - ${fieldId}::text` })
          .where(and(currentPreviews, isNotNull(previewConversations.chatId)));
        return;
      }
      await db
        .update(people)
        .set({ fieldValues: cleared ?? sql`${people.fieldValues} - ${fieldId}::text` })
        .where(eq(people.id, ownerId));
    },

    facts: {
      read: (ownerId) => (isPreviewOwner(ownerId) ? preview : people_).read(ownerId),
      add: (input) => (isPreviewOwner(input.ownerId) ? preview : people_).add(input),
      forget: (ownerId, id) => (isPreviewOwner(ownerId) ? preview : people_).forget(ownerId, id),
    },
  };
}

function entriesOf(values: Record<string, PersonFieldValue>, at: Date, chatId: string, flowId: string): ClientCardEntry[] {
  return Object.entries(values).map(([fieldId, value]) => ({ fieldId, value, updatedAt: at.toISOString(), chatId, flowId }));
}
