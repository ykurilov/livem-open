import { FlowTestClockError } from "@ykurilov/agent-chat-flows";
import type { FlowRunView } from "@ykurilov/agent-chat-flows";
import { findLeadMagnetByPreviewChat, getLeadMagnet, type LeadMagnet } from "../lead-magnets";
import type { Database } from "../platform/db";
import { isUuid } from "../platform/uuid";
import { isValidTimeZone } from "../program/calendar";
import type { LeadMagnetFlow } from "../flows/runtime";
import { readPreviewConversation } from "./preview-store";
import { MAX_REWIND_MS, MIN_REWIND_MS } from "./rewind-duration";

/** Перемотка часов тестового чата за один раз: целые миллисекунды от минуты до тридцати суток. */
const isRewindMs = (ms: unknown): ms is number => typeof ms === "number" && Number.isInteger(ms) && ms >= MIN_REWIND_MS && ms <= MAX_REWIND_MS;
const BAD_REWIND = "Укажите, на сколько промотать: от минуты до 30 суток";

/** Отказ, который эксперту надо показать словами: часы не двигаются. */
export class PreviewRefusal extends Error {}

/** Итог перемотки: сдвиг часов, мс, и (у «к напоминанию») что сработало. */
export type FlowTestClockResult = Awaited<ReturnType<LeadMagnetFlow["advanceTestClock"]>>;

/** Перемотка к напоминанию: впереди сценарий сам ничего не напишет. */
export class NothingScheduledRefusal extends PreviewRefusal {
  readonly code = "nothing_scheduled";
  constructor() {
    super("Впереди нет запланированных сообщений: агент сейчас первым не напишет");
  }
}

/** То, что доска берёт из места чата: нода, пройденный путь, день. */
export type FlowTestRun = Pick<FlowRunView, "state" | "path" | "day">;

export interface FlowTestRoutesOptions {
  db: Database;
  flow: LeadMagnetFlow;
  /** Владелец тестового чата (`previewOwnerId`, у старых чатов — общий владелец кабинета). */
  ownerOf(chatId: string): Promise<string>;
  /** Закрепить тестовый чат за сценарием без хода, по поясу браузера эксперта. */
  pinToFlow(chatId: string, timeZone?: string): Promise<void>;
  /** Текущий тестовый разговор лидмагнита; нет — начинает новый. */
  ensurePreview(leadMagnetId: string): Promise<string>;
  /** Новый тестовый разговор вместо текущего. */
  restartPreview(leadMagnetId: string): Promise<string>;
}

export interface FlowTestRoutes {
  /**
   * Часы тестового разговора лидмагнита — к началу следующего дня сценария. Возвращает сдвиг часов, мс. `timeZone` —
   * пояс браузера эксперта для чата, который ещё не за сценарием.
   */
  advanceToNextDay(lead: LeadMagnet, timeZone?: string): Promise<number>;
  /**
   * Часы тестового разговора лидмагнита — вперёд на `ms` (от минуты до тридцати суток); программа не нужна. Те же отказы
   * и то же закрепление за сценарием, что у `advanceToNextDay`. Возвращает сдвиг часов, мс.
   */
  advanceBy(lead: LeadMagnet, ms: number, timeZone?: string): Promise<number>;
  /**
   * Часы тестового разговора — ровно к тому, когда сценарий сам напишет первым (касание, утреннее, срок). Те же отказы,
   * что у остальной перемотки; впереди ничего — `NothingScheduledRefusal`. Возвращает сдвиг часов и причину.
   */
  advanceToNextFirstMessage(lead: LeadMagnet, timeZone?: string): Promise<FlowTestClockResult>;
  /**
   * Адреса тестового чата для доски: `flow-test/start`, `<чат>/flow-test/advance`, `<чат>/flow-test/run`. Вход уже
   * проверен вызывающим. Чат должен быть текущим тестовым разговором лидмагнита: боевые чаты людей, чат конструктора
   * и чужие id получают 404, а часы SDK у них не двигаются.
   */
  handle(request: Request, segments: string[]): Promise<Response>;
}

const refused = (status: number, kind: string, message: string) => Response.json({ error: { kind, message } }, { status });

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createFlowTestRoutes(options: FlowTestRoutesOptions): FlowTestRoutes {
  const { db, flow } = options;

  /** Тестовый разговор, у которого можно двигать часы: начат, не завершён, за сценарием (не писал — закрепляется сейчас). */
  async function movableTestChat(lead: LeadMagnet, timeZone?: string) {
    const state = lead.previewChatId ? await readPreviewConversation(db, lead.previewChatId) : null;
    if (!state) throw new PreviewRefusal("Тестовый разговор не начат");
    const ownerId = await options.ownerOf(state.chatId);
    // Эксперт ещё не писал: чат — за сценарий сейчас, дни — по поясу его браузера
    if (!(await flow.readRun(ownerId, state.chatId))) await options.pinToFlow(state.chatId, timeZone && isValidTimeZone(timeZone) ? timeZone : undefined);
    const run = await flow.readRun(ownerId, state.chatId);
    if (state.finishedAt || run?.endedAt !== undefined) throw new PreviewRefusal("Тестовый разговор завершён: начните проверку заново");
    return { ownerId, chatId: state.chatId, run };
  }

  async function advanceToNextDay(lead: LeadMagnet, timeZone?: string): Promise<number> {
    if (!lead.draft.flow.schedule) throw new PreviewRefusal("У этого лидмагнита нет воронки на несколько дней");
    const { ownerId, chatId, run } = await movableTestChat(lead, timeZone);
    if (run?.day?.isLastDay) throw new PreviewRefusal("Это последний день воронки");
    return (await flow.advanceTestClock({ ownerId, chatId, to: "next_day_start" })).timeOffset;
  }

  async function advanceBy(lead: LeadMagnet, ms: number, timeZone?: string): Promise<number> {
    if (!isRewindMs(ms)) throw new PreviewRefusal(BAD_REWIND);
    const { ownerId, chatId } = await movableTestChat(lead, timeZone);
    return (await flow.advanceTestClock({ ownerId, chatId, ms })).timeOffset;
  }

  async function advanceToNextFirstMessage(lead: LeadMagnet, timeZone?: string) {
    const { ownerId, chatId } = await movableTestChat(lead, timeZone);
    try {
      return await flow.advanceTestClock({ ownerId, chatId, to: "next_first_message" });
    } catch (error) {
      if (error instanceof FlowTestClockError && error.code === "nothing_scheduled") throw new NothingScheduledRefusal();
      throw error;
    }
  }

  async function start(request: Request): Promise<Response> {
    const body = await readBody(request);
    const leadMagnetId = typeof body.leadMagnetId === "string" ? body.leadMagnetId : "";
    if (!isUuid(leadMagnetId) || !(await getLeadMagnet(db, leadMagnetId))) return refused(404, "not_found", "Лидмагнит не найден");
    const chatId = await (body.restart === true ? options.restartPreview(leadMagnetId) : options.ensurePreview(leadMagnetId));
    return Response.json({ chatId });
  }

  async function advance(request: Request, lead: LeadMagnet, chatId: string): Promise<Response> {
    const body = await readBody(request);
    try {
      if (body.to === "next_day_start")
        return Response.json({ timeOffset: await advanceToNextDay(lead, typeof body.timeZone === "string" ? body.timeZone : undefined) });
      if (body.to === "next_first_message")
        return Response.json(await advanceToNextFirstMessage(lead, typeof body.timeZone === "string" ? body.timeZone : undefined));
      if (!isRewindMs(body.ms)) return refused(400, "bad_request", BAD_REWIND);
      return Response.json({ timeOffset: await advanceBy(lead, body.ms, typeof body.timeZone === "string" ? body.timeZone : undefined) });
    } catch (error) {
      if (error instanceof NothingScheduledRefusal) return refused(409, error.code, error.message);
      if (error instanceof PreviewRefusal) return refused(409, "refused", error.message);
      throw error;
    }
  }

  async function handle(request: Request, segments: string[]): Promise<Response> {
    if (request.method !== "POST") return refused(405, "method_not_allowed", "Только POST");
    if (segments[0] === "flow-test") return segments[1] === "start" && segments.length === 2 ? start(request) : refused(404, "not_found", "Нет такого адреса");

    const chatId = decodeURIComponent(segments[0] ?? "");
    const action = segments[2];
    if (segments.length !== 3 || (action !== "advance" && action !== "run")) return refused(404, "not_found", "Нет такого адреса");
    const lead = await findLeadMagnetByPreviewChat(db, chatId);
    if (!lead) {
      if (await readPreviewConversation(db, chatId))
        return refused(409, "stale_preview", "Этот тестовый разговор уже начат заново. Обновите страницу, чтобы продолжить в новом.");
      return refused(404, "not_found", "Тестовый разговор не найден");
    }
    if (action === "advance") return advance(request, lead, chatId);
    const run = await flow.readRun(await options.ownerOf(chatId), chatId);
    return Response.json({ run: run ? ({ state: run.state, path: run.path, ...(run.day && { day: run.day }) } satisfies FlowTestRun) : null });
  }

  return { advanceToNextDay, advanceBy, advanceToNextFirstMessage, handle };
}
