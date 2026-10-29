// Приложение «как в бою» на базе eval: конструктор, бот в подделке мессенджера и живой диалог консультанта.
// Те же инструкции, инструменты, сценарий и код ходов, что в приложении; подменены только мессенджер, очередь и часы.
import { randomBytes, randomUUID } from "node:crypto";
import {
  createRunningAnswerRegistry,
  loadCurrentBranch,
  type ChatStorage,
  type ModelChoice,
  type StoredMessage,
  type UsageSource,
} from "@ykurilov/agent-chat-core";
import type { FlowRunView } from "@ykurilov/agent-chat-flows";
import { flowDay } from "@ykurilov/agent-chat-flows/format";
import { postgresFlowStore } from "@ykurilov/agent-chat-flows/postgres";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { splitAgentLogErrors, type JournalEntry } from "./agent-log-errors";
import { Pool } from "pg";
import { createAgentLogRecorder, withAgentLog } from "@/modules/agent-log";
import { agentLogEntries } from "@/modules/agent-log/schema";
import { textShortLinks } from "@/modules/text-links/schema";
import { createAlerts } from "@/modules/alerts";
import type { BotCredentials } from "@/modules/channels";
import { FakeChannel } from "@/modules/channels/fake";
import { bots, outboundMessages } from "@/modules/channels/schema";
import { createConstructorEndpoint } from "@/modules/constructor/endpoint";
import { createLiveDialog } from "@/modules/conversations/live-dialog";
import { passages } from "@/modules/conversations/schema";
import { createLeadMagnet, getLeadMagnet, getVersion, saveDraft, type LeadMagnetSettings } from "@/modules/lead-magnets";
import { applyAgentInput, parseAgentInput } from "@/modules/lead-magnet-cli/agent-settings";
import { attachBot, publishLeadMagnet } from "@/modules/lead-magnets/publish";
import { people } from "@/modules/people/schema";
import type { AppModels } from "@/modules/platform/app-models";
import { openChatStorage } from "@/modules/platform/chat-storage";
import { createFakeClock, type FakeClock } from "@/modules/platform/clock";
import { createTokenCipher } from "@/modules/platform/crypto";
import type { Database } from "@/modules/platform/db";
import { AGENT_TIME_ZONE } from "@/modules/platform/models-catalog";
import type { JobName, JobPayloads } from "@/modules/platform/queue";
import { updateSettings } from "@/modules/platform/settings";
import { atLocalTime, localDate, localTime, nextLocalTime } from "@/modules/program";
import { FakeQueue } from "../tests/integration/live-dialog-kit";
import { storedChat, textAfterTool, textOf, toolCallsOf } from "./chat-parts";
import {
  SILENCE_TILL_END,
  type BotMessageKind,
  type ClientFlowRun,
  type ClientRun,
  type ClientUsage,
  type ConstructorTurn,
  type ConsultantTurn,
  type EventMoment,
  type StoredChatMessage,
  type TimedBotMessage,
  type UsageTotals,
} from "./types";
import { totalUsage } from "./usage";

const CIPHER = createTokenCipher(Buffer.alloc(32, 7).toString("base64"));
const FINISH_TOOL = "finish_dialog";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Человек читает ответ и пишет следующее сообщение. */
const TYPING_MS = MINUTE_MS;
/** Ответ на сообщение ждём столько по часам стенда: склейка, повтор хода, отправка. Дальше — уже не ответ, а следующий день. */
const REPLY_HORIZON_MS = 30 * MINUTE_MS;
/** Клиент пишет первым по Москве, если в карточке не сказано иначе: днём тихие часы не откладывают ходы. */
const DEFAULT_START = "12:00";
/** Начало дня без «Дней и времени» — конец тихих часов приложения: к нему клиент возвращается «завтра». */
const MORNING = "09:00";
/** Молчание после разговора длится, пока он не кончится сам, но не дольше: «не завершил» — через 3 дня тишины. */
const TILL_END_MAX_MS = 5 * DAY_MS;
/** Таймер сценария наступил, а обход его не взял (аренда другой копии, сбой хода): часы — на столько вперёд. */
const STUCK_TIMER_STEP_MS = MINUTE_MS;
/**
 * Задачи, которых стенд не выполняет: уборка зависших и старые напоминания до среза S6 — их заменили касания
 * сценария. Строки, а не `JobName`: после S6 задачи `reminder` нет.
 */
const SKIPPED_JOBS: ReadonlySet<string> = new Set(["stuck-sweep", "reminder"]);

/** Клиент молчит: до утра следующего дня или столько часов. */
export type Silence = "tomorrow" | number;

export interface ClientLine {
  /** Сообщение клиента боту; ждёт, пока приложение доделает всё, что из него следует. */
  send(text: string, extra?: { startCode?: string }): Promise<ConsultantTurn>;
  /** Клиент молчит: часы стенда идут вперёд, приложение делает всё, что положено за это время. */
  wait(silence: Silence): Promise<ConsultantTurn>;
  /** Клиент ушёл и молчит, пока разговор не кончится сам: касания, потом «не завершил» или «срок вышел». */
  waitTillEnd(): Promise<ConsultantTurn>;
  passage(): Promise<ClientRun["passage"]>;
  /** Короткие ссылки разговора (`/i/<код>`) и полные за ними: для сверки с идеей. */
  shortLinks(): Promise<NonNullable<ClientRun["shortLinks"]>>;
  chat(): Promise<StoredChatMessage[]>;
  /** Путь по сценарию и чем он кончился. */
  flowRun(): Promise<ClientFlowRun | undefined>;
  /** Расход разговора по назначениям журнала SDK. */
  usage(): Promise<ClientUsage | undefined>;
}

export interface AppUnderTest {
  askConstructor(text: string): Promise<ConstructorTurn>;
  constructorChat(): Promise<StoredChatMessage[]>;
  draft(): Promise<LeadMagnetSettings | null>;
  /** Лидмагнит из JSON в формате scripts/lm.sh вместо сборки конструктором. */
  useLeadMagnet(input: unknown): Promise<LeadMagnetSettings>;
  /** Привязывает бота и публикует; возвращает код для /start. */
  publish(): Promise<string>;
  /** `startsAt` — во сколько по Москве клиент пишет первым. */
  /** `profileName` — имя в профиле мессенджера; не задано — id клиента, как ник. */
  openClientLine(userId: string, options?: { startsAt?: string; profileName?: string }): Promise<ClientLine>;
  /** Ошибки журнала агентов: упавшие вызовы и сбои провайдера, которые закрыл запасной путь. */
  agentLogErrors(): Promise<{ errors: string[]; recovered: string[] }>;
  usage(): Promise<UsageTotals>;
  /** Часть расхода агентов: судья, сообщения первым, переписка ответа. */
  usageBySource(): Promise<{ judge: UsageTotals; firstMessage: UsageTotals; answerCorrection: UsageTotals }>;
  close(): Promise<void>;
}

interface FlowStoreDatabase {
  pool: Pool;
  drop(): Promise<void>;
}

/**
 * Склад сценариев SDK у каждого клиента — своя пустая база рядом с базой сценария eval. У клиентов свои часы, а обход
 * таймеров берёт все наступившие чаты склада: на общем складе клиент, ушедший в день 3, будил бы чаты отставших. Наш
 * код таблиц склада не читает, таблицы SDK создаёт сам.
 */
async function createFlowStoreDatabase(databaseUrl: string): Promise<FlowStoreDatabase> {
  const url = new URL(databaseUrl);
  const name = `${url.pathname.slice(1).slice(0, 50)}_f${randomBytes(3).toString("hex")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  return {
    pool,
    async drop() {
      await pool.end();
      const dropper = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        await dropper.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await dropper.end();
      }
    },
  };
}

export async function startAppUnderTest(input: {
  db: Database;
  databaseUrl: string;
  models: AppModels;
  privacyPolicyUrl: string;
  /** Запасной судья сценария; нет — как в приложении (DeepSeek 4.1 Flash). Подставной модели — она сама. */
  judgeFallback?: ModelChoice;
}): Promise<AppUnderTest> {
  const { db, models } = input;
  await updateSettings(db, { privacyPolicyUrl: input.privacyPolicyUrl });
  const storage = await openChatStorage(input.databaseUrl);
  const registry = createRunningAnswerRegistry();
  const flowStores: FlowStoreDatabase[] = [];
  const settles: Array<() => Promise<void>> = [];
  const recorder = createAgentLogRecorder(db, models.env);
  const catalog = withAgentLog(models.catalog, recorder);

  const endpoint = createConstructorEndpoint({
    db,
    chatStorage: storage,
    catalog,
    defaultChoice: models.constructorChoice,
    env: models.env,
    resolveUser: async () => ({ id: "eval" }),
  });
  const lead = await createLeadMagnet(db, { name: "Новый лидмагнит" });
  const constructorChatId = await endpoint.ensureChat(lead.id);

  const channel = new FakeChannel();
  const token = `eval-${randomUUID()}`;
  const [botRow] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: "Бот eval",
      externalId: `ext-${token}`,
      username: "eval_bot",
      tokenEncrypted: CIPHER.encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  if (!botRow) throw new Error("Бот eval не создался");
  const bot: BotCredentials = { id: botRow.id, token, externalId: botRow.externalId, username: botRow.username, webhookSecret: botRow.webhookSecret };

  const today = localDate(new Date(), null);

  const usageOf = async (filter: { chatId?: string; source: UsageSource }) => totalUsage(await storage.sumUsage(filter));

  async function openClientLine(userId: string, options: { startsAt?: string; profileName?: string } = {}): Promise<ClientLine> {
    const clock: FakeClock = createFakeClock(atLocalTime(today, options.startsAt ?? DEFAULT_START, null));
    const queue = new FakeQueue(clock);
    const alerts = createAlerts({ db, clock, notifier: { send: async () => {} } });
    const flowDatabase = await createFlowStoreDatabase(input.databaseUrl);
    flowStores.push(flowDatabase);
    // Тот же склад, что у сценария клиента: срок ближайшего таймера его чата
    const flowStore = postgresFlowStore(flowDatabase.pool);
    const dialog = createLiveDialog({
      db,
      pool: flowDatabase.pool,
      queue,
      clock,
      adapters: { telegram: channel },
      cipher: CIPHER,
      alerts,
      chatStorage: withoutPendingBursts(storage),
      catalog,
      env: models.env,
      registry,
      modelChoice: (settings) => models.consultantChoice(settings),
      // Часы подменены и стоят: окно пачки SDK проходит, когда их сдвигаем мы
      afterBurstRecorded: ({ quietMs }) => clock.advance(quietMs),
      ...(input.judgeFallback && { judgeFallback: input.judgeFallback }),
    });
    const { flow } = dialog;
    settles.push(() => flow.settled());
    const handlers: { [Name in JobName]?: (payload: JobPayloads[Name]) => Promise<void> } = {
      "inbound-route": ({ inboundMessageId }) => dialog.routeInbound(inboundMessageId),
      "inbound-turn": ({ passageId }) => dialog.runTurn(passageId),
      "outbound-send": ({ outboundMessageId }) => dialog.sendOutbound(outboundMessageId),
      "budget-check": async () => void (await dialog.checkBudget()),
      // Напоминание об оплате курса («беру», а оплаты нет): уходит назавтра сообщением первым
      "payment-reminder": ({ passageId }) => dialog.remindPayment(passageId),
      "purchase-congratulate": ({ passageId }) => dialog.congratulatePurchase(passageId),
    };

    const delivered: TimedBotMessage[] = [];

    /** Что ушло клиенту за работу: со временем стенда и видом исходящего. */
    async function recordDelivered(work: () => Promise<void>, kindOf: (text: string) => Promise<BotMessageKind>): Promise<void> {
      const seen = channel.messagesTo(userId).length;
      await work();
      const fresh = channel.messagesTo(userId).slice(seen);
      if (fresh.length === 0) return;
      const at = await momentNow();
      for (const entry of fresh) delivered.push({ ...at, kind: await kindOf(entry.message.text), text: entry.message.text });
    }

    async function runJob(job: { name: JobName; payload: unknown }): Promise<void> {
      if (SKIPPED_JOBS.has(job.name)) return;
      const handler = handlers[job.name] as ((payload: unknown) => Promise<void>) | undefined;
      if (!handler) throw new Error(`Нет обработчика задачи ${job.name}`);
      const outboundId = job.name === "outbound-send" ? (job.payload as JobPayloads["outbound-send"]).outboundMessageId : null;
      await recordDelivered(
        () => handler(job.payload),
        async (text) => (outboundId ? outboundKind(outboundId, text) : "other"),
      );
    }

    /** Фраза жёсткой рамки уходит ответом хода без модели: узнаём её по тексту рамки из сценария. */
    async function outboundKind(outboundMessageId: string, text: string): Promise<BotMessageKind> {
      const [row] = await db.select({ kind: outboundMessages.kind }).from(outboundMessages).where(eq(outboundMessages.id, outboundMessageId));
      if (row?.kind === "consultant") return text === (await settings())?.flow.schedule?.dayFrame?.hardText ? "day_closed" : "consultant";
      return row?.kind === "outreach" ? "outreach" : "other";
    }

    /** Как работник между задачами: фоновая работа сценария (судья, доставка), обход таймеров по часам стенда. */
    async function tickFlow(): Promise<void> {
      await flow.settled();
      // Сообщения первым, которые доставка сценария отправила сама, мимо очереди
      await recordDelivered(
        async () => {
          await flow.tick();
          await flow.settled();
        },
        async () => "outreach",
      );
    }

    /** Срок ближайшего таймера сценария этого клиента; разговор кончился — таймеров нет. */
    async function flowDueAt(): Promise<number | undefined> {
      const chatId = (await latestPassage())?.chatId;
      const record = chatId ? await flowStore.getChat(chatId) : null;
      if (!record?.dueAt || record.endedAt) return undefined;
      const due = Date.parse(record.dueAt);
      return due > clock.now().getTime() ? due : clock.now().getTime() + STUCK_TIMER_STEP_MS;
    }

    const nextJobAt = () => {
      const jobs = queue.pending.filter((job) => !SKIPPED_JOBS.has(job.name));
      return jobs.length ? Math.min(...jobs.map((job) => job.runAt)) : undefined;
    };

    /**
     * Как работник приложения: задачи по сроку и таймеры сценария, часы — к следующему. `reply` — ответ на сообщение:
     * часы идут только к задачам разговора в пределах получаса, таймеры сценария срабатывают, лишь если их срок уже
     * наступил. `silence` — клиент молчит до `until`: часы идут и к таймерам; `stop` прерывает молчание.
     */
    async function drain(mode: { kind: "reply" } | { kind: "silence"; until: number; stop?: () => boolean | Promise<boolean> }): Promise<void> {
      const until = mode.kind === "reply" ? clock.now().getTime() + REPLY_HORIZON_MS : mode.until;
      for (let guard = 0; guard < 1000; guard++) {
        let job = queue.takeDue();
        while (job) {
          await runJob(job);
          if (mode.kind === "silence" && (await mode.stop?.())) return;
          job = queue.takeDue();
        }
        await tickFlow();
        if (mode.kind === "silence" && (await mode.stop?.())) return;
        if (queue.pending.some((pending) => pending.runAt <= clock.now().getTime() && !SKIPPED_JOBS.has(pending.name))) continue;
        const candidates = [nextJobAt(), mode.kind === "silence" ? await flowDueAt() : undefined].filter((at): at is number => at !== undefined);
        const next = candidates.length ? Math.min(...candidates) : undefined;
        if (next === undefined || next > until) return;
        clock.set(new Date(Math.max(next, clock.now().getTime())));
      }
      throw new Error("Очередь и таймеры сценария не утихли за 1000 шагов");
    }

    async function person() {
      const [row] = await db
        .select()
        .from(people)
        .where(and(eq(people.externalUserId, userId), eq(people.botId, bot.id)));
      return row;
    }

    async function latestPassage() {
      const found = await person();
      if (!found) return undefined;
      const [row] = await db.select().from(passages).where(eq(passages.personId, found.id)).orderBy(desc(passages.startedAt)).limit(1);
      return row;
    }

    const snapshots = new Map<string, LeadMagnetSettings | null>();
    /** Настройки снимка, по которому идёт разговор. */
    async function settings(): Promise<LeadMagnetSettings | null> {
      const snapshotId = (await latestPassage())?.snapshotId;
      if (!snapshotId) return null;
      if (!snapshots.has(snapshotId)) snapshots.set(snapshotId, (await getVersion(db, snapshotId))?.settings ?? null);
      return snapshots.get(snapshotId)!;
    }

    async function timeZone(): Promise<string> {
      return (await person())?.timeZone ?? AGENT_TIME_ZONE;
    }

    async function readRun(): Promise<FlowRunView | null> {
      const passage = await latestPassage();
      return passage ? flow.readRun(passage.personId, passage.chatId) : null;
    }

    async function consultantMessageCount(): Promise<number> {
      const found = await person();
      if (!found) return 0;
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(outboundMessages)
        .where(and(eq(outboundMessages.personId, found.id), eq(outboundMessages.kind, "consultant")));
      return row?.count ?? 0;
    }

    async function chatMessages(): Promise<StoredMessage[]> {
      const passage = await latestPassage();
      return passage ? loadCurrentBranch(storage, passage.chatId) : [];
    }

    /** Сейчас по часам стенда: время и дата у человека, у «Дней и времени» — день сценария. */
    async function momentNow(): Promise<EventMoment> {
      const now = clock.now();
      const zone = await timeZone();
      const day = (await readRun())?.day?.day;
      return { at: now.toISOString(), ...(day !== undefined && { day }), localTime: localTime(now, zone), localDate: localDate(now, zone) };
    }

    /** Что изменилось за ход или молчание: сообщения бота, ответы и инструменты консультанта. */
    async function observe(before: { startedAt: number; delivered: number; consultant: number; passageId?: string; chat: number }) {
      const passageAfter = (await latestPassage())?.id;
      const chat = await chatMessages();
      const fresh = chat.slice(passageAfter === before.passageId ? before.chat : 0).filter((message) => message.role === "assistant");
      const tools = toolCallsOf(fresh);
      const finished = tools.some((tool) => tool.name === FINISH_TOOL);
      const timeline = delivered.slice(before.delivered);
      return {
        bot: timeline.map((message) => message.text),
        ...(timeline.length > 0 && { timeline }),
        consultantMessages: (await consultantMessageCount()) - before.consultant,
        tools,
        finished,
        textAfterFinish: finished ? textAfterTool(fresh, FINISH_TOOL) : null,
        durationMs: Date.now() - before.startedAt,
      };
    }

    async function snapshot() {
      return {
        startedAt: Date.now(),
        delivered: delivered.length,
        consultant: await consultantMessageCount(),
        passageId: (await latestPassage())?.id,
        chat: (await chatMessages()).length,
      };
    }

    /** До начала следующего дня у человека (`dayStart` сценария, без него — 9:00): утреннее приходит само. */
    async function waitTillTomorrow(): Promise<void> {
      const day = (await readRun())?.day;
      const morning = day ? day.nextDayStartAt : nextLocalTime((await settings())?.flow.schedule?.dayStart ?? MORNING, clock.now(), await timeZone()).getTime();
      const from = delivered.length;
      await drain({ kind: "silence", until: morning, stop: () => delivered.slice(from).some((message) => Date.parse(message.at) >= morning) });
      clock.set(new Date(Math.max(clock.now().getTime(), morning)));
    }

    const isActive = async () => (await latestPassage())?.status === "active";

    async function silentTurn(silence: string, wait: () => Promise<void>): Promise<ConsultantTurn> {
      const before = await snapshot();
      await wait();
      const sentAt = await momentNow();
      return { client: "", silence, sentAt, ...(await observe(before)) };
    }

    let eventCounter = 0;

    return {
      async send(text, extra = {}) {
        // Сценарий доделал своё (судья после прошлого ответа, доставка) — только потом клиент пишет снова
        await flow.settled();
        if (eventCounter > 0) clock.advance(TYPING_MS);
        const before = await snapshot();
        const sentAt = await momentNow();

        await dialog.acceptWebhook({
          channel: "telegram",
          botId: bot.id,
          request: channel.webhookRequest(bot, [
            {
              type: "message",
              dedupeKey: `telegram:${bot.id}:${userId}:${++eventCounter}`,
              userId,
              userName: options.profileName ?? userId,
              text,
              ...(extra.startCode && { startCode: extra.startCode }),
            },
          ]),
        });
        await drain({ kind: "reply" });
        return { client: text, ...(await observe(before)), sentAt };
      },

      wait(silence) {
        if (silence === "tomorrow") return silentTurn("до завтра", waitTillTomorrow);
        return silentTurn(`${silence} ч`, async () => {
          const until = clock.now().getTime() + silence * HOUR_MS;
          await drain({ kind: "silence", until });
          clock.set(new Date(Math.max(until, clock.now().getTime())));
        });
      },

      waitTillEnd() {
        return silentTurn(SILENCE_TILL_END, async () => {
          if (!(await isActive())) return;
          await drain({ kind: "silence", until: clock.now().getTime() + TILL_END_MAX_MS, stop: async () => !(await isActive()) });
        });
      },

      async passage() {
        const row = await latestPassage();
        if (!row) return null;
        return { status: row.status, summary: row.summary ?? null, personMessageCount: row.personMessageCount, handoverReason: row.handoverReason };
      },

      async chat() {
        return storedChat(await chatMessages());
      },

      async shortLinks() {
        const chatId = (await latestPassage())?.chatId;
        if (!chatId) return [];
        return db.select({ code: textShortLinks.code, target: textShortLinks.targetUrl }).from(textShortLinks).where(eq(textShortLinks.chatId, chatId));
      },

      async flowRun() {
        await flow.settled();
        const run = await readRun();
        const flowSettings = (await settings())?.flow;
        if (!run || !flowSettings) return undefined;
        const zone = await timeZone();
        const titles = new Map(flowSettings.states.map((state) => [state.id, state.title]));
        return {
          transitions: run.path.map((step) => ({
            to: step.state,
            title: titles.get(step.state) ?? step.state,
            from: step.from,
            decidedBy: step.decidedBy,
            reason: step.reason?.text ?? null,
            day: flowSettings.schedule ? flowDay(run, step.at, zone, flowSettings.schedule).day : null,
            at: new Date(step.at).toISOString(),
            tags: step.tags,
          })),
          endReason: run.endReason ?? null,
        };
      },

      async usage() {
        const chatId = (await latestPassage())?.chatId;
        if (!chatId) return undefined;
        const [answer, firstMessage, correction, judge] = await Promise.all(
          (["answer", "first_message", "answer_correction", "judge"] as const).map((source) => usageOf({ chatId, source })),
        );
        return { answerUsd: answer!.costUsd, firstMessageUsd: firstMessage!.costUsd, correctionUsd: correction!.costUsd, judgeUsd: judge!.costUsd };
      },
    };
  }

  return {
    async askConstructor(text) {
      const startedAt = Date.now();
      const response = await endpoint.fetch(
        new Request(`http://localhost/api/constructor/${constructorChatId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: { id: randomUUID(), role: "user", parts: [{ type: "text", text }] } }),
        }),
      );
      const body = await response.text();
      const answer = (await loadCurrentBranch(storage, constructorChatId)).at(-1);
      if (!response.ok || answer?.role !== "assistant") {
        return {
          expert: text,
          reply: "",
          tools: [],
          status: "error",
          error: `Ответ конструктора не получен: HTTP ${response.status} ${body.slice(0, 300)}`,
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        expert: text,
        reply: textOf([answer]),
        tools: toolCallsOf([answer]),
        status: answer.status,
        ...(answer.error && { error: answer.error.kind }),
        durationMs: Date.now() - startedAt,
      };
    },

    async constructorChat() {
      return storedChat(await loadCurrentBranch(storage, constructorChatId));
    },

    async draft() {
      return (await getLeadMagnet(db, lead.id))?.draft ?? null;
    },

    async useLeadMagnet(input) {
      const parsed = parseAgentInput(JSON.stringify(input));
      return db.transaction(async (tx) => {
        const current = await getLeadMagnet(tx, lead.id);
        if (!current) throw new Error("Лидмагнит eval пропал");
        const settings = await applyAgentInput(tx, current.draft, parsed, { creating: true });
        return (await saveDraft(tx, lead.id, settings, "agent")).settings;
      });
    },

    async publish() {
      await attachBot(db, { leadMagnetId: lead.id, botId: bot.id });
      return (await publishLeadMagnet(db, lead.id)).code;
    },

    openClientLine,

    async agentLogErrors() {
      await recorder.flush();
      // Удачные вызовы тоже нужны: по ним видно, что после сбоя провайдера ход ответил запасным путём
      const rows = await db
        .select({ turnId: agentLogEntries.turnId, data: agentLogEntries.data })
        .from(agentLogEntries)
        .where(inArray(agentLogEntries.kind, ["model", "tool"]))
        .orderBy(asc(agentLogEntries.id));
      return splitAgentLogErrors(rows as JournalEntry[]);
    },

    async usage() {
      return totalUsage(await storage.sumUsage({}));
    },

    async usageBySource() {
      const [judge, firstMessage, answerCorrection] = await Promise.all((["judge", "first_message", "answer_correction"] as const).map((source) => usageOf({ source })));
      return { judge: judge!, firstMessage: firstMessage!, answerCorrection: answerCorrection! };
    },

    async close() {
      await Promise.all(settles.map((settle) => settle()));
      await recorder.flush();
      await storage.close();
      await Promise.all(flowStores.map((store) => store.drop()));
    },
  };
}

/** Методы хранилища для ждущих пачек (`answerAfterRestart`). */
const PENDING_BURST_METHODS: ReadonlySet<PropertyKey> = new Set(["savePendingBurst", "takeAbandonedBursts", "renewPendingBurst", "removePendingBurst"]);

/**
 * Хранилище линии клиента без ждущих пачек. У каждой линии свои часы, а хранилище общее: ждущую пачку одной линии другая,
 * чьи часы ушли на дни вперёд, сочла бы брошенной и забрала себе (SDK требует, чтобы часы копий расходились меньше чем
 * на 30 с). Линия не перезапускается: окно пачки живёт в памяти её службы. Ответ после перезапуска проверяют тесты.
 */
function withoutPendingBursts(storage: ChatStorage): ChatStorage {
  return new Proxy(storage, {
    get(target, property) {
      if (PENDING_BURST_METHODS.has(property)) return undefined;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
