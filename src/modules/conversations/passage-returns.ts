import type { AgentFlow, FlowDuration } from "@ykurilov/agent-chat-flows";
import { eq } from "drizzle-orm";
import { getVersion } from "../lead-magnets";
import type { DatabaseExecutor } from "../platform/db";
import { passageReturns, passages, type PassageReturnKind } from "./schema";

const UNIT_MS = { min: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 } as const;
const DEFAULT_REMIND_MS = 3 * UNIT_MS.d;
/** Короче любой «Напоминать»: сообщения подряд снимок не читают. */
const SHORTEST_REMIND_MS = UNIT_MS.d;

const durationMs = (duration: FlowDuration) => duration.amount * UNIT_MS[duration.unit];

/**
 * «Напоминать» сценария: сколько тишины агент ещё касается человека. У прежних сценариев без `stopAfter` касания идут
 * до «не завершил» (`giveUpAfter`); нет и его — 3 дня.
 */
export function remindWindowMs(flow: Pick<AgentFlow, "nudges">): number {
  const window = flow.nudges?.stopAfter ?? flow.nudges?.giveUpAfter;
  return window ? durationMs(window) : DEFAULT_REMIND_MS;
}

type ReturningPassage = { id: string; leadMagnetId: string; snapshotId: string; lastPersonMessageAt: Date | null };

async function noteReturn(tx: DatabaseExecutor, passage: ReturningPassage, kind: PassageReturnKind, at: Date): Promise<void> {
  await tx.insert(passageReturns).values({ passageId: passage.id, leadMagnetId: passage.leadMagnetId, kind, at });
}

async function silentLongerThanRemind(tx: DatabaseExecutor, passage: ReturningPassage, now: Date): Promise<boolean> {
  if (!passage.lastPersonMessageAt) return false;
  const silence = now.getTime() - passage.lastPersonMessageAt.getTime();
  if (silence <= SHORTEST_REMIND_MS) return false;
  const snapshot = await getVersion(tx, passage.snapshotId);
  return silence > (snapshot ? remindWindowMs(snapshot.settings.flow) : DEFAULT_REMIND_MS);
}

/** Сообщение в идущий или открытый заново разговор после молчания дольше «Напоминать» — возврат после паузы. */
export async function noteReturnAfterPause(tx: DatabaseExecutor, passage: ReturningPassage, now: Date): Promise<void> {
  if (await silentLongerThanRemind(tx, passage, now)) await noteReturn(tx, passage, "after_pause", now);
}

/**
 * Сообщение в законченный разговор, который агент продолжает: первое после конца — возврат после конца; дальше — только
 * после молчания дольше «Напоминать», сообщения подряд не считаются.
 */
export async function noteReturnAfterEnd(tx: DatabaseExecutor, passageId: string, now: Date): Promise<void> {
  const [passage] = await tx.select().from(passages).where(eq(passages.id, passageId));
  if (!passage) return;
  const firstAfterEnd = passage.returnedAfterEndAt === null || (passage.endedAt !== null && (passage.lastPersonMessageAt ?? passage.endedAt) <= passage.endedAt);
  if (firstAfterEnd || (await silentLongerThanRemind(tx, passage, now))) await noteReturn(tx, passage, "after_end", now);
}
