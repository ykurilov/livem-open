import { loadCurrentBranch, type ChatStorage, type StoredMessage } from "@ykurilov/agent-chat-core";
import type { AgentFlow, FlowState } from "@ykurilov/agent-chat-flows/format";
import { desc, eq } from "drizzle-orm";
import { bots } from "../channels/schema";
import { expertReplyText } from "../consultant/expert-reply";
import { isOutreachRequest } from "../consultant/outreach-request";
import type { DialogSummary } from "../consultant/schema";
import { passages, type PassageStatus } from "../conversations/schema";
import { entryLinks, leadMagnets, leadMagnetVersions } from "../lead-magnets/schema";
import type { DatabaseExecutor } from "../platform/db";
import { fieldValueText, getFields } from "./fields";
import { imageUrl, sentImagesOf } from "../images";
import { sentVideosOf, videoMessageText, type ShownVideoLink } from "../videos";
import { people, type PersonFact } from "./schema";

export interface PersonCardMessage {
  /** `expert` — эксперт сам ответил из «Входящих». */
  role: "user" | "assistant" | "expert";
  text: string;
  /** Ролик, который прислал консультант: в мессенджер он ушёл отдельным сообщением. */
  video?: ShownVideoLink;
  /** Картинка, которую показал консультант: в мессенджер она ушла фото с ответом. */
  image?: { title: string; url: string };
}

export interface PersonCardPassage {
  id: string;
  leadMagnetName: string;
  /** Метка ссылки; `null` — основная ссылка или без ссылки. */
  linkLabel: string | null;
  status: PassageStatus;
  /** Этап, на котором разговор сейчас или остановился; `null` — у лидмагнита нет этапов. */
  stageName: string | null;
  summary: DialogSummary | null;
  costUsd: number;
  startedAt: Date;
  endedAt: Date | null;
  messages: PersonCardMessage[];
}

export interface PersonCard {
  id: string;
  displayName: string | null;
  channel: typeof people.$inferSelect.channel;
  botTitle: string;
  blockedAt: Date | null;
  createdAt: Date;
  /** Откуда человек, если пришёл не через лидмагнит. */
  source: typeof people.$inferSelect.source;
  /** Значения полей словаря (удалённые поля не показываются). */
  fields: Array<{ id: string; name: string; value: string }>;
  facts: PersonFact[];
  /** Новые сверху. */
  passages: PersonCardPassage[];
}

function textOf(message: StoredMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

async function conversation(chatStorage: ChatStorage, chatId: string): Promise<PersonCardMessage[]> {
  if (!(await chatStorage.getChat(chatId))) return [];
  const branch = await loadCurrentBranch(chatStorage, chatId);
  // Ролики — те, что человек получил: по одному за ответ и без повторов
  const replies = branch.filter((message) => message.role === "assistant");
  const sentVideos = new Map(sentVideosOf(replies.map((message) => message.parts)).map((video, index) => [replies[index]!.id, video]));
  const sentImages = new Map(sentImagesOf(replies.map((message) => message.parts)).map((image, index) => [replies[index]!.id, image]));
  return branch.flatMap((message): PersonCardMessage[] => {
    // Просьба «напиши первым» — служебная, человек её не писал
    if (isOutreachRequest(message)) return [];
    const expert = expertReplyText(message);
    if (expert !== null) return expert ? [{ role: "expert", text: expert }] : [];
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = textOf(message);
    const video = sentVideos.get(message.id);
    const image = sentImages.get(message.id);
    return [
      ...(text ? [{ role: message.role, text }] : []),
      ...(image ? [{ role: message.role, text: `🖼 ${image.title}`, image: { title: image.title, url: imageUrl(image.fileName) } }] : []),
      ...(video ? [{ role: message.role, text: videoMessageText(video), video }] : []),
    ];
  });
}

/**
 * Нода сценария, где идёт разговор: названия правят на доске, этапы настроек тогда устаревают. Нода ещё не сменилась —
 * стартовая. Разговор из одной ноды этапа не показывает.
 */
function stageOf(flow: AgentFlow, stateId: string | null): FlowState | undefined {
  if (flow.states.filter((state) => state.exits.length > 0).length < 2) return undefined;
  return flow.states.find((state) => state.id === (stateId ?? flow.start));
}

/** Карточка человека: поля, факты, прохождения с итогами и полная переписка. `null` — человека нет. */
export async function loadPersonCard(
  deps: { db: DatabaseExecutor; chatStorage: ChatStorage },
  personId: string,
): Promise<PersonCard | null> {
  const { db } = deps;
  const [person] = await db
    .select({ person: people, botTitle: bots.title })
    .from(people)
    .innerJoin(bots, eq(bots.id, people.botId))
    .where(eq(people.id, personId));
  if (!person) return null;

  const rows = await db
    .select({
      passage: passages,
      draft: leadMagnets.draft,
      snapshot: leadMagnetVersions.settings,
      linkLabel: entryLinks.label,
    })
    .from(passages)
    .innerJoin(leadMagnets, eq(leadMagnets.id, passages.leadMagnetId))
    .innerJoin(leadMagnetVersions, eq(leadMagnetVersions.id, passages.snapshotId))
    .leftJoin(entryLinks, eq(entryLinks.id, passages.entryLinkId))
    .where(eq(passages.personId, personId))
    .orderBy(desc(passages.startedAt));

  const values = person.person.fieldValues;
  const known = await getFields(db, Object.keys(values));

  const cardPassages = await Promise.all(
    rows.map(async ({ passage, draft, snapshot, linkLabel }): Promise<PersonCardPassage> => {
      const stage = stageOf(snapshot.flow, passage.currentStageId);
      return {
        id: passage.id,
        leadMagnetName: draft.name,
        linkLabel,
        status: passage.status,
        stageName: stage ? stage.title.trim() || stage.id : null,
        summary: passage.summary,
        costUsd: Number(passage.costUsd),
        startedAt: passage.startedAt,
        endedAt: passage.endedAt,
        messages: await conversation(deps.chatStorage, passage.chatId),
      };
    }),
  );

  return {
    id: person.person.id,
    displayName: person.person.displayName,
    channel: person.person.channel,
    botTitle: person.botTitle,
    blockedAt: person.person.blockedAt,
    createdAt: person.person.createdAt,
    source: person.person.source,
    fields: known
      .sort((a, b) => a.name.localeCompare(b.name, "ru"))
      .map((field) => ({ id: field.id, name: field.name, value: fieldValueText(values[field.id]!) })),
    facts: person.person.facts,
    passages: cardPassages,
  };
}
