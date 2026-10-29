/** Узкая операция только для first-app: CAS + существующие сервисы версий/публикации/перевода. */
import { createHash } from "node:crypto";
import { foldAppState, selectCurrentBranch, withoutGlueFragments, type StoredMessage } from "@ykurilov/agent-chat-core";
import { sql } from "drizzle-orm";
import { parseFlow, type AgentFlow } from "@ykurilov/agent-chat-flows/format";
import blueprint from "../../../docs/lead-magnets/first-app.json";
import previous from "../../../docs/lead-magnets/history/first-app-six-states.json";
import { saveEditBesideConstructor } from "../constructor/manual-edits";
import { getLeadMagnet, lockLeadMagnet, type LeadMagnet } from "../lead-magnets/lead-magnets";
import { publishLeadMagnet } from "../lead-magnets/publish";
import type { LeadMagnetSettings } from "../lead-magnets/settings";
import type { Database, DatabaseExecutor } from "../platform/db";
import type { migrateLiveChats } from "./chat-migration";
import { withLeadMagnetFlow } from "./flow-settings";
import { FIRST_APP_DURABLE_GATE_READY } from "./first-app-readiness";
import { FIRST_APP_ID } from "./first-app-confirmations";

export { FIRST_APP_DURABLE_GATE_READY } from "./first-app-readiness";
export { FIRST_APP_ID } from "./first-app-confirmations";
export const FIRST_APP_STATE_MAP = { first_version: "idea", publish: "result", polish: "result" } as const;
export interface FirstAppExpected {
  draftVersionId: string;
  publishedSnapshotId: string | null;
  updatedAt: string;
}
export type FirstAppRolloutMode = "plan" | "draft" | "publish" | "migrate";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function statesFrom(current: AgentFlow, states: unknown): AgentFlow["states"] {
  const parsed = parseFlow({ ...current, states });
  if (!parsed.ok) throw new Error(`Сценарий не прошёл разбор: ${JSON.stringify(parsed.errors)}`);
  return parsed.flow.states;
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/** Сохраняет всё живое, кроме запрошенных нод; поля, общая инструкция, расписание и настройки покупки не заменяются файлом. */
export function simplifiedFirstAppSettings(current: LeadMagnetSettings): LeadMagnetSettings {
  if (!same(current.flow.states, statesFrom(current.flow, previous.flow.states)))
    throw new Error("Ноды текущего черновика отличаются от проверенного прежнего first-app; требуется новое сравнение");
  const layout = Object.fromEntries(Object.entries(current.flow.layout).filter(([id]) => !(id in FIRST_APP_STATE_MAP)));
  return withLeadMagnetFlow(current, { ...current.flow, states: statesFrom(current.flow, blueprint.flow.states), layout });
}

export function firstAppExpected(lead: LeadMagnet): FirstAppExpected {
  return { draftVersionId: lead.draftVersionId, publishedSnapshotId: lead.publishedSnapshotId, updatedAt: lead.updatedAt.toISOString() };
}
function assertExpected(lead: LeadMagnet, expected: FirstAppExpected) {
  if (!same(firstAppExpected(lead), expected)) throw new Error("Версия/draft/publication/updatedAt изменились; запись отменена. Повторите plan и ревью");
}

type PublicationProof = { kind: "historical_publish_done" | "ambiguous"; reason: string };
/** Это инвентаризация прежнего checked-перехода, не новый receipt и не вывод по имени текущей ноды. */
export function historicalPublicationProof(run: unknown, flow: unknown, versionAt: number): PublicationProof {
  const ambiguous = (reason: string): PublicationProof => ({ kind: "ambiguous", reason });
  if (!run || typeof run !== "object" || !flow || typeof flow !== "object") return ambiguous("no_readable_run_or_version");
  const parsed = parseFlow(flow);
  if (!parsed.ok) return ambiguous("unknown_original_flow");
  const publication = parsed.flow.states.find((s) => s.id === "publish")?.exits.find((e) => e.id === "publish_done");
  const original = previous.flow.states.find((s) => s.id === "publish")!.exits![0]!;
  if (!publication || publication.to !== "polish" || !same(publication.when, original.when)) return ambiguous("unverified_original_publish_condition");
  const data = run as { startedAt?: number; path?: Array<{ at: number; state: string; from: string | null; exitId: string | null; decidedBy: string }> };
  const path = data.path;
  // В старом path нет versionId у каждого элемента. Любая миграция/обрезка/история до создания версии неоднозначна.
  if (!Array.isArray(path) || path[0]?.decidedBy !== "start" || path[0]?.from !== null || path[0]?.at !== data.startedAt)
    return ambiguous("truncated_or_unplaced_path");
  if (typeof data.startedAt !== "number" || data.startedAt < versionAt || path.some((p) => p.decidedBy === "migrate")) return ambiguous("path_version_not_proven");
  const checked = path.some((p) => p.from === "publish" && p.state === "polish" && p.exitId === "publish_done" && ["claim", "judge"].includes(p.decidedBy));
  // В 0.68 нет versionId у элемента path, а миграция со стабильным id не оставляет отметки migrate.
  // Даже точное совпадение ниже — лишь кандидат для внешнего аудита, не durable подтверждение.
  return checked ? ambiguous("unversioned_checked_publish_done") : ambiguous("no_original_checked_publish_done");
}

async function liveCounts(db: DatabaseExecutor, id: string) {
  const existence = await db.execute<{ flows: boolean; messages: boolean }>(sql`select
    to_regclass('agent_chat.flow_chats') is not null as flows,
    to_regclass('agent_chat.messages') is not null and to_regclass('agent_chat.branch_selections') is not null as messages`);
  if (!existence.rows[0]?.flows) return [];
  const result = await db.execute<{ chat_id: string; version_id: string; state_id: string; version_at: Date | null; flow: unknown }>(sql`
    select p.chat_id, fc.version_id, fc.state_id, v.created_at as version_at, v.settings->'flow' as flow
    from app.passages p join agent_chat.flow_chats fc on fc.chat_id = p.chat_id
    left join app.lead_magnet_versions v on v.id::text = fc.version_id and v.lead_magnet_id = p.lead_magnet_id
    where p.lead_magnet_id = ${id} and p.status = 'active' and fc.flow_id = ${id} and fc.ended_at is null
    order by fc.version_id, fc.state_id, p.chat_id`);
  const groups = new Map<string, { versionId: string; from: string; to: string; chats: number; proof: PublicationProof }>();
  for (const row of result.rows) {
    let proof: PublicationProof = { kind: "ambiguous", reason: "no_readable_persisted_state" };
    if (existence.rows[0]?.messages) {
      // Читаем только служебные записи состояния и граф веток, без текста переписки. Никаких SDK migrations/init.
      const messages = await db.execute<{ id: string; parent_id: string | null; created_at: string; role: StoredMessage["role"]; parts: StoredMessage["parts"] }>(sql`
        select m.id, m.parent_id, m.created_at, m.role,
          coalesce((select jsonb_agg(part) from jsonb_array_elements(m.parts::jsonb) part
            where part->>'type' in ('data-app-state', 'data-voice-mode')), '[]'::jsonb) as parts
        from agent_chat.messages m where m.chat_id = ${row.chat_id} order by m.created_at, m.seq`);
      const selections = await db.execute<{ message_id: string; selected_at: string }>(sql`
        select message_id, selected_at from agent_chat.branch_selections where chat_id = ${row.chat_id} order by seq`);
      const branch = selectCurrentBranch(withoutGlueFragments(messages.rows.map((m) => ({ id: m.id, parentId: m.parent_id, createdAt: m.created_at, role: m.role, parts: m.parts }))),
        selections.rows.map((s) => ({ messageId: s.message_id, selectedAt: s.selected_at })));
      const run = foldAppState(branch).flow;
      proof = row.version_at ? historicalPublicationProof(run, row.flow, new Date(row.version_at).getTime()) : { kind: "ambiguous", reason: "missing_original_version" };
    }
    const key = `${row.version_id}:${row.state_id}:${proof.kind}:${proof.reason}`;
    const existing = groups.get(key);
    if (existing) existing.chats++;
    else groups.set(key, { versionId: row.version_id, from: row.state_id,
      to: FIRST_APP_STATE_MAP[row.state_id as keyof typeof FIRST_APP_STATE_MAP] ?? row.state_id, chats: 1, proof });
  }
  return [...groups.values()];
}
function assertNewStates(settings: LeadMagnetSettings) {
  if (!same(settings.flow.states, statesFrom(settings.flow, blueprint.flow.states))) throw new Error("Черновик не содержит проверенные четыре рабочие ноды");
}

/** Перед write lead блокируется, сравнение версии выполняется внутри той же транзакции. plan — read-only snapshot. */
export async function runFirstAppRollout(db: Database, input: {
  mode: FirstAppRolloutMode;
  expected: FirstAppExpected;
  by: { email: string; name?: string };
  at: Date;
  /** Не передаётся из CLI: только для изолированных тестовых данных. */
  leadMagnetId?: string;
}) {
  // Даже сохранение draft делает кандидат доступным обычной UI-публикации: закрываем все записи до БД.
  if (input.mode !== "plan" && !FIRST_APP_DURABLE_GATE_READY)
    throw new Error("Запись first-app (draft/publish/migrate) заблокирована: требуется поддерживаемое durable подтверждение своей публикации в SDK");
  const id = input.leadMagnetId ?? FIRST_APP_ID;
  return db.transaction(async (tx) => {
    if (input.mode === "plan") await tx.execute(sql`set transaction isolation level repeatable read, read only`);
    const lead = input.mode === "plan" ? await getLeadMagnet(tx, id) : await lockLeadMagnet(tx, id);
    if (!lead) throw new Error("Лидмагнит не найден");
    assertExpected(lead, input.expected);
    const counts = await liveCounts(tx, id);
    const working = new Set(blueprint.flow.states.filter((state) => "exits" in state).map((state) => state.id));
    if (counts.some((row) => !working.has(row.to))) throw new Error("Есть чаты с неизвестной нодой: требуется явная карта после ревью");
    const isNew = same(lead.draft.flow.states, statesFrom(lead.draft.flow, blueprint.flow.states));
    if (!isNew) simplifiedFirstAppSettings(lead.draft); // Проверка исходного контракта также в dry-run.
    let migrated: Awaited<ReturnType<typeof migrateLiveChats>> | undefined;
    if (input.mode === "draft") {
      if (isNew) throw new Error("Упрощённый сценарий уже сохранён; повторная версия не создаётся");
      if (lead.draftVersionId !== lead.publishedSnapshotId) throw new Error("Есть неопубликованные правки: сначала отдельное ревью");
      await saveEditBesideConstructor(tx, lead, simplifiedFirstAppSettings(lead.draft), "agent");
    } else if (input.mode === "publish") {
      assertNewStates(lead.draft);
      await publishLeadMagnet(tx, id);
    } else if (input.mode === "migrate") {
      assertNewStates(lead.draft);
      if (lead.draftVersionId !== lead.publishedSnapshotId) throw new Error("Публикация отличается от проверенного черновика");
      // Эта выкладка только для новых разговоров. Legacy без versioned receipt остаются immutable.
      // Исторические path/card здесь не создают proof. Миграция намеренно пропускается.
      migrated = { chats: 0, pending: 0, toVersionId: lead.publishedSnapshotId! };
    }
    const after = input.mode === "plan" ? lead : (await getLeadMagnet(tx, id))!;
    return { mode: input.mode, leadMagnetId: id, ...firstAppExpected(after),
      simplified: input.mode === "draft" || isNew, durableGateReady: FIRST_APP_DURABLE_GATE_READY,
      mapping: FIRST_APP_STATE_MAP,
      eligibility: {
        eligible: counts.filter((g) => g.proof.kind === "historical_publish_done").reduce((n, g) => n + g.chats, 0),
        keepOriginal: counts.filter((g) => g.proof.kind === "ambiguous").reduce((n, g) => n + g.chats, 0),
        ambiguous: counts.filter((g) => g.proof.kind === "ambiguous").reduce((n, g) => n + g.chats, 0),
      },
      proofCounts: {
        unversionedCheckedCandidates: counts.filter((g) => g.proof.reason === "unversioned_checked_publish_done").reduce((n, g) => n + g.chats, 0),
        historicalCheckedPublishDone: counts.filter((g) => g.proof.kind === "historical_publish_done").reduce((n, g) => n + g.chats, 0),
        ambiguous: counts.filter((g) => g.proof.kind === "ambiguous").reduce((n, g) => n + g.chats, 0),
      }, liveChats: counts.reduce((n, row) => n + row.chats, 0), groups: counts,
      sourceStatesSha256: createHash("sha256").update(stable(blueprint.flow.states)).digest("hex"),
      ...(migrated ? { migration: migrated } : {}) };
  });
}
