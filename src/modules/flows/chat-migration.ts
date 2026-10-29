// Перевод идущих разговоров на новую версию лидмагнита (кнопка на странице публикации). Наши данные — снимок
// прохождения и строка «Лога» — меняются одной транзакцией; сценарий SDK переводит чаты после коммита, задачей
// работника (`applyChatMigration`), как и `flow.end`. Только боевые идущие разговоры: тестовые чаты «Проверки» и
// закрытые разговоры остаются на своей версии.
import type { AgentFlowHandle } from "@ykurilov/agent-chat-flows";
import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { inArray, sql } from "drizzle-orm";
import { recordChatMigration, type ChatMigrationMove } from "../agent-log";
import { passages } from "../conversations/schema";
import { getLeadMagnet, LeadMagnetNotFoundError, lockLeadMagnet } from "../lead-magnets";
import { leadMagnetVersions } from "../lead-magnets/schema";
import type { Database, DatabaseExecutor } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { isUuid } from "../platform/uuid";
import { agentFlowOf, currentRulesOf } from "./runtime";

export class ChatMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatMigrationError";
  }
}

/** Куда отправить людей из нод, которых в новой версии нет: id прежней ноды → id ноды новой версии. */
export type StateMap = Record<string, string>;

/** Разговоры одной прежней версии в одной ноде. */
export interface OldVersionGroup {
  versionId: string;
  versionAt: Date;
  stateId: string;
  stateTitle: string;
  chats: number;
  /** Нода есть и в новой версии: люди продолжат с неё же. */
  inNewVersion: boolean;
  /** Куда отправить по умолчанию: та же нода или ближайшая по порядку. */
  suggestedTo: string;
}

export interface ChatMigrationPlan {
  toVersionId: string;
  toVersionAt: Date;
  total: number;
  groups: OldVersionGroup[];
  /** Уже переведены в наших данных, сценарий SDK ещё переводит (задача работника). */
  pending: number;
  /** Ноды новой версии, куда можно отправить людей: все, кроме конечных. */
  targets: Array<{ id: string; title: string }>;
}

interface LiveChat {
  passageId: string;
  chatId: string;
  /** Версия и нода чата в SDK. */
  versionId: string;
  stateId: string;
  /** Снимок и нода прохождения в наших данных: после нашей записи — уже новые. */
  snapshotId: string;
  currentStageId: string | null;
}

interface VersionFlow {
  at: Date;
  flow: AgentFlow | null;
}

const FLOW_CHATS = sql.raw("agent_chat.flow_chats");

async function flowChatsExist(db: DatabaseExecutor): Promise<boolean> {
  const { rows } = await db.execute<{ found: boolean }>(sql`select to_regclass('agent_chat.flow_chats') is not null as found`);
  return rows[0]?.found === true;
}

/**
 * Идущие боевые разговоры лидмагнита, чей чат SDK ещё не на версии `toVersionId`. Место — по SDK: его нода и есть
 * та, с которой человек продолжит. `snapshot`: `old` — ещё не переведённые нашей записью, `new` — уже переведённые.
 */
async function liveChatsOffVersion(
  db: DatabaseExecutor,
  input: { leadMagnetId: string; toVersionId: string; snapshot?: "old" | "new"; lock?: boolean },
): Promise<LiveChat[]> {
  if (!(await flowChatsExist(db))) return [];
  const { rows } = await db.execute<{
    passage_id: string;
    chat_id: string;
    version_id: string;
    state_id: string;
    snapshot_id: string;
    current_stage_id: string | null;
  }>(sql`
    select p.id as passage_id, p.chat_id, fc.version_id, fc.state_id, p.snapshot_id, p.current_stage_id
    from ${passages} p
    join ${FLOW_CHATS} fc on fc.chat_id = p.chat_id
    where p.lead_magnet_id = ${input.leadMagnetId}
      and p.status = 'active'
      and fc.flow_id = ${input.leadMagnetId}
      and fc.ended_at is null
      and fc.version_id <> ${input.toVersionId}
      ${input.snapshot === "old" ? sql`and p.snapshot_id <> ${input.toVersionId}` : sql``}
      ${input.snapshot === "new" ? sql`and p.snapshot_id = ${input.toVersionId}` : sql``}
    order by p.started_at, p.id
    ${input.lock ? sql`for update of p` : sql``}`);
  return rows.map((row) => ({
    passageId: row.passage_id,
    chatId: row.chat_id,
    versionId: row.version_id,
    stateId: row.state_id,
    snapshotId: row.snapshot_id,
    currentStageId: row.current_stage_id,
  }));
}

async function versionFlows(db: DatabaseExecutor, versionIds: string[]): Promise<Map<string, VersionFlow>> {
  if (versionIds.length === 0) return new Map();
  const rows = await db
    .select({ id: leadMagnetVersions.id, settings: leadMagnetVersions.settings, createdAt: leadMagnetVersions.createdAt })
    .from(leadMagnetVersions)
    .where(inArray(leadMagnetVersions.id, [...new Set(versionIds)]));
  return new Map(rows.map((row) => [row.id, { at: row.createdAt, flow: agentFlowOf(currentRulesOf(row.settings.flow)) }]));
}

/** Ноды, куда можно отправить людей: нода без выходов — конец разговора, туда не переводят. */
const targetsOf = (flow: AgentFlow) => flow.states.filter((state) => state.exits.length > 0).map((state) => ({ id: state.id, title: state.title }));

/** Та же нода, если она есть, иначе ближайшая по порядку в прежней версии: сначала следующая, потом предыдущая. */
function suggestedTarget(stateId: string, oldFlow: AgentFlow | null, next: AgentFlow): string {
  const targets = new Set(targetsOf(next).map((state) => state.id));
  if (next.states.some((state) => state.id === stateId)) return stateId;
  const order = oldFlow?.states.map((state) => state.id) ?? [];
  const index = order.indexOf(stateId);
  if (index >= 0) {
    for (let distance = 1; distance < order.length; distance++) {
      for (const candidate of [order[index + distance], order[index - distance]]) if (candidate && targets.has(candidate)) return candidate;
    }
  }
  if (next.start && targets.has(next.start)) return next.start;
  return targetsOf(next)[0]?.id ?? next.start ?? stateId;
}

function titleIn(flow: AgentFlow | null | undefined, stateId: string): string | undefined {
  return flow?.states.find((state) => state.id === stateId)?.title;
}

/** Нода новой версии для разговора: та же, если есть; иначе выбор эксперта; не выбрал — подсказка. */
function targetOf(chat: LiveChat, map: StateMap, oldFlow: AgentFlow | null, next: AgentFlow): string {
  if (next.states.some((state) => state.id === chat.stateId)) return chat.stateId;
  return map[chat.stateId] ?? suggestedTarget(chat.stateId, oldFlow, next);
}

function groupsOf(chats: LiveChat[], flows: Map<string, VersionFlow>, next: AgentFlow): OldVersionGroup[] {
  const groups = new Map<string, OldVersionGroup>();
  for (const chat of chats) {
    const key = `${chat.versionId}\0${chat.stateId}`;
    const group = groups.get(key);
    if (group) {
      group.chats += 1;
      continue;
    }
    const old = flows.get(chat.versionId);
    groups.set(key, {
      versionId: chat.versionId,
      versionAt: old?.at ?? new Date(0),
      stateId: chat.stateId,
      stateTitle: titleIn(old?.flow, chat.stateId) ?? titleIn(next, chat.stateId) ?? chat.stateId,
      chats: 1,
      inNewVersion: next.states.some((state) => state.id === chat.stateId),
      suggestedTo: suggestedTarget(chat.stateId, old?.flow ?? null, next),
    });
  }
  const order = (group: OldVersionGroup) => flows.get(group.versionId)?.flow?.states.findIndex((state) => state.id === group.stateId) ?? -1;
  return [...groups.values()].sort((a, b) => a.versionAt.getTime() - b.versionAt.getTime() || a.versionId.localeCompare(b.versionId) || order(a) - order(b));
}

async function publishedFlow(db: DatabaseExecutor, snapshotId: string): Promise<{ at: Date; flow: AgentFlow }> {
  const next = (await versionFlows(db, [snapshotId])).get(snapshotId);
  if (!next?.flow) throw new ChatMigrationError("У опубликованной версии нет сценария");
  return { at: next.at, flow: next.flow };
}

/** Сколько идущих разговоров на прежних версиях и в каких нодах. Лидмагнит не опубликован — `null`. */
export async function planChatMigration(db: DatabaseExecutor, leadMagnetId: string): Promise<ChatMigrationPlan | null> {
  const lead = isUuid(leadMagnetId) ? await getLeadMagnet(db, leadMagnetId) : null;
  if (!lead?.publishedSnapshotId) return null;
  const toVersionId = lead.publishedSnapshotId;
  const next = await publishedFlow(db, toVersionId);
  const all = await liveChatsOffVersion(db, { leadMagnetId, toVersionId });
  const chats = all.filter((chat) => chat.snapshotId !== toVersionId);
  const flows = await versionFlows(db, chats.map((chat) => chat.versionId));
  return {
    toVersionId,
    toVersionAt: next.at,
    total: chats.length,
    groups: groupsOf(chats, flows, next.flow),
    pending: all.length - chats.length,
    targets: targetsOf(next.flow),
  };
}

export interface MigrateLiveChatsInput {
  leadMagnetId: string;
  map: StateMap;
  /** Кто переводит. */
  by: { name?: string; email: string };
  at: Date;
}

export interface MigrateLiveChatsResult {
  chats: number;
  toVersionId: string;
  /** Переведённые раньше, которых сценарий SDK ещё не перевёл: задачу работника стоит поставить и для них. */
  pending: number;
}

/**
 * Перевод в наших данных — одной транзакцией: прохождения на опубликованный снимок (отчёт, карточка и «Входящие»
 * показывают новую версию), нода у отправленных из удалённых нод и строка «Лога». Чаты SDK переводит
 * `applyChatMigration` после коммита. Нечего переводить — ни записи, ни строки «Лога».
 */
export async function migrateLiveChats(db: Database, input: MigrateLiveChatsInput): Promise<MigrateLiveChatsResult> {
  const { leadMagnetId } = input;
  if (!isUuid(leadMagnetId)) throw new LeadMagnetNotFoundError(leadMagnetId);
  return db.transaction(async (tx) => {
    const lead = await lockLeadMagnet(tx, leadMagnetId);
    const toVersionId = lead.publishedSnapshotId;
    if (!toVersionId) throw new ChatMigrationError("Лидмагнит не опубликован");
    const next = await publishedFlow(tx, toVersionId);
    const targets = new Set(targetsOf(next.flow).map((state) => state.id));
    for (const to of Object.values(input.map)) if (!targets.has(to)) throw new ChatMigrationError(`Нода «${to}» не из новой версии`);

    const all = await liveChatsOffVersion(tx, { leadMagnetId, toVersionId, lock: true });
    const chats = all.filter((chat) => chat.snapshotId !== toVersionId);
    const pending = all.length - chats.length;
    if (chats.length === 0) return { chats: 0, toVersionId, pending };
    const flows = await versionFlows(tx, chats.map((chat) => chat.versionId));

    const moves = new Map<string, ChatMigrationMove>();
    const byTarget = new Map<string, string[]>();
    for (const chat of chats) {
      const old = flows.get(chat.versionId);
      const to = targetOf(chat, input.map, old?.flow ?? null, next.flow);
      if (to !== chat.stateId) byTarget.set(to, [...(byTarget.get(to) ?? []), chat.passageId]);
      const key = `${chat.versionId}\0${chat.stateId}\0${to}`;
      const move = moves.get(key);
      if (move) move.chats += 1;
      else
        moves.set(key, {
          fromVersionId: chat.versionId,
          fromVersionAt: (old?.at ?? new Date(0)).toISOString(),
          from: titleIn(old?.flow, chat.stateId) ?? chat.stateId,
          to: titleIn(next.flow, to) ?? to,
          chats: 1,
        });
    }

    await tx.update(passages).set({ snapshotId: toVersionId }).where(inArray(passages.id, chats.map((chat) => chat.passageId)));
    for (const [to, ids] of byTarget) await tx.update(passages).set({ currentStageId: to }).where(inArray(passages.id, ids));
    const name = input.by.name?.trim();
    await recordChatMigration(tx, leadMagnetId, {
      kind: "migration",
      at: input.at.toISOString(),
      durationMs: 0,
      by: name ? `${name} (${input.by.email})` : input.by.email,
      chats: chats.length,
      toVersionId,
      toVersionAt: next.at.toISOString(),
      moves: [...moves.values()],
    });
    return { chats: chats.length, toVersionId, pending };
  });
}

export interface ApplyChatMigrationDependencies {
  db: Database;
  flow: Pick<AgentFlowHandle, "chatsByState" | "migrateChats">;
}

/**
 * Перевод в сценарии SDK — задача работника после коммита `migrateLiveChats`. Переводит ровно те чаты, чьи прохождения
 * уже на новом снимке (отбор `chatIds`, один и тот же в счёте и переводе); люди из удалённых нод встают в ноду
 * прохождения — её записал `migrateLiveChats`. Закончившиеся и тестовые чаты «Проверки» SDK сам не трогает. Повтор
 * ничего не ломает: переведённые уже на версии.
 */
export async function applyChatMigration(
  deps: ApplyChatMigrationDependencies,
  input: { leadMagnetId: string; toVersionId: string },
): Promise<{ moved: number }> {
  const { leadMagnetId, toVersionId } = input;
  const chats = await liveChatsOffVersion(deps.db, { leadMagnetId, toVersionId, snapshot: "new" });
  if (chats.length === 0) return { moved: 0 };
  const next = await publishedFlow(deps.db, toVersionId);
  const flows = await versionFlows(deps.db, chats.map((chat) => chat.versionId));
  const selection = { chatIds: chats.map((chat) => chat.chatId) };

  // SDK требует цель для каждой удалённой ноды, где есть отобранные чаты
  const targets = new Set(targetsOf(next.flow).map((state) => state.id));
  const map: StateMap = {};
  for (const chat of chats) {
    const chosen: StateMap = chat.currentStageId && targets.has(chat.currentStageId) ? { [chat.stateId]: chat.currentStageId } : {};
    const to = targetOf(chat, chosen, flows.get(chat.versionId)?.flow ?? null, next.flow);
    if (to !== chat.stateId) map[chat.stateId] ??= to;
  }
  for (const row of await deps.flow.chatsByState(leadMagnetId, { exceptVersionId: toVersionId, ...selection }))
    if (!next.flow.states.some((state) => state.id === row.stateId)) map[row.stateId] ??= suggestedTarget(row.stateId, null, next.flow);

  return deps.flow.migrateChats({ flowId: leadMagnetId, toVersionId, map, flow: next.flow, ...selection });
}

/**
 * Восстановление перевода, чья задача `chats-migrate` не встала: процесс упал после коммита `migrateLiveChats` или
 * очередь отказала. Признак — расхождение, которое оставляет только перевод: снимок идущего прохождения уже новый, а чат
 * SDK закреплён на другой версии (`adopt` закрепляет чат ровно на снимке прохождения). Разговоры прежних версий без
 * перевода, тестовые чаты «Проверки» и закончившиеся разговоры сюда не попадают. Задача ставится на версию, куда
 * прохождения перевели наши данные; повтор лишней задачи ничего не ломает. Возвращает число поставленных задач.
 */
export async function requeuePendingChatMigrations(deps: { db: DatabaseExecutor; queue: JobEnqueuer }): Promise<number> {
  if (!(await flowChatsExist(deps.db))) return 0;
  const { rows } = await deps.db.execute<{ lead_magnet_id: string; snapshot_id: string }>(sql`
    select distinct p.lead_magnet_id, p.snapshot_id
    from ${passages} p
    join ${FLOW_CHATS} fc on fc.chat_id = p.chat_id
    where p.status = 'active'
      and fc.flow_id = p.lead_magnet_id::text
      and fc.ended_at is null
      and fc.version_id <> p.snapshot_id::text
    order by p.lead_magnet_id, p.snapshot_id`);
  for (const row of rows) await deps.queue.enqueue("chats-migrate", { leadMagnetId: row.lead_magnet_id, toVersionId: row.snapshot_id });
  return rows.length;
}
