import { and, asc, eq, isNotNull, isNull, lt, min, or, sql } from "drizzle-orm";
import type { AlertService } from "../alerts";
import { bots, enqueueOutbound, outboundMessages, type ChannelAdapters } from "../channels";
import { parsePeopleFilter } from "../people";
import type { Clock } from "../platform/clock";
import type { Database } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { fixRecipients } from "./recipients";
import { mailingRecipients, mailings } from "./schema";

export interface MailingJobDependencies {
  db: Database;
  queue: JobEnqueuer;
  clock: Clock;
  adapters: ChannelAdapters;
  alerts: AlertService;
}

/** Обработчики задач `mailing-start` и `mailing-batch` и подмётчик потерянных задач рассылок. */
export interface MailingJobs {
  start(mailingId: string): Promise<void>;
  batch(mailingId: string): Promise<void>;
  /** Часть задачи `stuck-sweep`: ставит заново потерянные старты и порции. Возвращает, сколько поставлено. */
  sweep(): Promise<number>;
}

/** Порция — столько секунд отправки на бота; следующая порция ставится через это время. */
export const BATCH_SECONDS = 10;
/** Все порции поставлены, но сообщения ещё в пути: через столько секунд проверить снова. */
export const FINISH_CHECK_SECONDS = 15;
/** Бот не в порядке дольше этого с первого замеченного сбоя — его получатели «не доставлено», эксперту тревога. */
export const BOT_DOWN_GRACE_MS = 15 * 60_000;
/** Старт или порция опаздывают дольше этого — задача потерялась, а не просто ещё в пути. */
export const MAILING_STUCK_AFTER_MS = 60_000;

const preview = (text: string) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

export function createMailingJobs(deps: MailingJobDependencies): MailingJobs {
  const { db, queue, clock } = deps;
  const after = (seconds: number) => new Date(clock.now().getTime() + seconds * 1000);
  const waitingOf = (mailingId: string) =>
    and(eq(mailingRecipients.mailingId, mailingId), isNull(mailingRecipients.outboundMessageId), isNull(mailingRecipients.error));

  return {
    /**
     * Старт в назначенное время: фиксирует получателей. Отменённая или уже начатая рассылка не стартует второй раз:
     * дубль старта не заводит вторую цепочку порций, а потерянную первую порцию поставит подмётчик.
     */
    async start(mailingId) {
      const outcome = await db.transaction(async (tx) => {
        const [mailing] = await tx.select().from(mailings).where(eq(mailings.id, mailingId)).for("update");
        if (!mailing || mailing.status !== "scheduled") return "nothing";
        const waitMs = (mailing.scheduledAt?.getTime() ?? 0) - clock.now().getTime();
        if (waitMs > 0) return { waitSeconds: Math.ceil(waitMs / 1000) };

        const recipientCount = await fixRecipients(tx, mailingId, parsePeopleFilter(mailing.filter));
        await tx
          .update(mailings)
          .set({ status: "sending", recipientCount, startedAt: clock.now(), batchDueAt: clock.now() })
          .where(eq(mailings.id, mailingId));
        return "batch";
      });
      if (outcome === "batch") await queue.enqueue("mailing-batch", { mailingId });
      else if (outcome !== "nothing") await queue.enqueue("mailing-start", { mailingId }, { delaySeconds: outcome.waitSeconds });
    },

    /**
     * Очередная порция: каждому боту — столько сообщений, сколько он успеет за `BATCH_SECONDS` по своей скорости,
     * с отсрочкой по секундам внутри порции. Порция раньше своего срока — дубль цепочки, она ничего не делает;
     * а если два обработчика всё же разошлют одну порцию, у каждого получателя свой ключ отправки.
     */
    async batch(mailingId) {
      const mailing = await claimBatch(mailingId);
      if (!mailing) return;

      const waiting = waitingOf(mailingId);
      const botIds = await db.selectDistinct({ botId: mailingRecipients.botId }).from(mailingRecipients).where(waiting);

      for (const { botId } of botIds) {
        const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
        const adapter = bot && deps.adapters[bot.channel];
        if (!bot || bot.deletedAt) {
          await failBotRecipients(mailing, botId, `Бот${bot ? ` «${bot.title}»` : ""} удалён — сообщение не отправлено`);
          continue;
        }
        if (!adapter || bot.status !== "ok") {
          await waitForBot(mailing, botId, bot.title);
          continue;
        }
        // Бот вернулся: отсчёт сбоя начнётся заново, если он снова упадёт
        await db
          .update(mailingRecipients)
          .set({ botDownSince: null })
          .where(and(waiting, eq(mailingRecipients.botId, botId), isNotNull(mailingRecipients.botDownSince)));
        const rate = adapter.ratePerSecond;
        const portion = await db
          .select({ personId: mailingRecipients.personId })
          .from(mailingRecipients)
          .where(and(waiting, eq(mailingRecipients.botId, botId)))
          .orderBy(asc(mailingRecipients.personId))
          .limit(Math.max(1, Math.floor(rate * BATCH_SECONDS)));
        for (const [index, { personId }] of portion.entries()) {
          const { id } = await enqueueOutbound(deps, {
            botId,
            personId,
            kind: "mailing",
            text: mailing.text,
            ...(mailing.imagePath && { imagePath: mailing.imagePath }),
            mailingId,
            idempotencyKey: `mailing:${mailingId}:${personId}`,
            delaySeconds: Math.floor(index / rate),
          });
          await db
            .update(mailingRecipients)
            .set({ outboundMessageId: id })
            .where(and(eq(mailingRecipients.mailingId, mailingId), eq(mailingRecipients.personId, personId)));
        }
      }

      const [left] = await db.select({ count: sql<number>`count(*)::int` }).from(mailingRecipients).where(waiting);
      if ((left?.count ?? 0) > 0) return scheduleBatch(mailingId, BATCH_SECONDS);
      const [inFlight] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(outboundMessages)
        .where(and(eq(outboundMessages.mailingId, mailingId), eq(outboundMessages.status, "queued")));
      if ((inFlight?.count ?? 0) > 0) return scheduleBatch(mailingId, FINISH_CHECK_SECONDS);
      await db
        .update(mailings)
        .set({ status: "done", finishedAt: clock.now(), batchDueAt: null })
        .where(and(eq(mailings.id, mailingId), eq(mailings.status, "sending")));
    },

    async sweep() {
      const overdue = new Date(clock.now().getTime() - MAILING_STUCK_AFTER_MS);
      const lostBatches = await db
        .select({ id: mailings.id })
        .from(mailings)
        .where(and(eq(mailings.status, "sending"), or(isNull(mailings.batchDueAt), lt(mailings.batchDueAt, overdue))));
      for (const { id } of lostBatches) await queue.enqueue("mailing-batch", { mailingId: id });
      const lostStarts = await db
        .select({ id: mailings.id })
        .from(mailings)
        .where(and(eq(mailings.status, "scheduled"), lt(mailings.scheduledAt, overdue)));
      for (const { id } of lostStarts) await queue.enqueue("mailing-start", { mailingId: id });
      return lostBatches.length + lostStarts.length;
    },
  };

  /** Берёт порцию в работу, если её срок пришёл. Сразу отодвигает срок: дубль, пришедший следом, ничего не сделает. */
  async function claimBatch(mailingId: string): Promise<typeof mailings.$inferSelect | null> {
    return db.transaction(async (tx) => {
      const [mailing] = await tx.select().from(mailings).where(eq(mailings.id, mailingId)).for("update");
      if (!mailing || mailing.status !== "sending") return null;
      if (mailing.batchDueAt && mailing.batchDueAt.getTime() > clock.now().getTime()) return null;
      await tx.update(mailings).set({ batchDueAt: after(BATCH_SECONDS) }).where(eq(mailings.id, mailingId));
      return mailing;
    });
  }

  /** Следующая порция. Сначала задача, потом срок: если запись срока не удастся, повтор этой порции не потеряет цепочку. */
  async function scheduleBatch(mailingId: string, delaySeconds: number): Promise<void> {
    await queue.enqueue("mailing-batch", { mailingId }, { delaySeconds });
    await db
      .update(mailings)
      .set({ batchDueAt: after(delaySeconds) })
      .where(and(eq(mailings.id, mailingId), eq(mailings.status, "sending")));
  }

  /** Бот не в порядке: получатели ждут. Не вернулся за `BOT_DOWN_GRACE_MS` с первого замеченного сбоя — «не доставлено». */
  async function waitForBot(mailing: typeof mailings.$inferSelect, botId: string, botTitle: string): Promise<void> {
    const ofBot = and(waitingOf(mailing.id), eq(mailingRecipients.botId, botId));
    await db
      .update(mailingRecipients)
      .set({ botDownSince: clock.now() })
      .where(and(ofBot, isNull(mailingRecipients.botDownSince)));
    const [row] = await db.select({ since: min(mailingRecipients.botDownSince) }).from(mailingRecipients).where(ofBot);
    if (!row?.since || clock.now().getTime() - row.since.getTime() < BOT_DOWN_GRACE_MS) return;
    await failBotRecipients(mailing, botId, `Бот «${botTitle}» отключён — сообщение не отправлено`, botTitle);
  }

  /**
   * Бот отключён или удалён: его получатели помечаются недоставленными.
   * Тревога — только про отключённый (T097): удалил эксперт сам, ему это известно.
   */
  async function failBotRecipients(mailing: typeof mailings.$inferSelect, botId: string, error: string, disabledBotTitle?: string) {
    const failed = await db
      .update(mailingRecipients)
      .set({ error })
      .where(
        and(
          eq(mailingRecipients.mailingId, mailing.id),
          eq(mailingRecipients.botId, botId),
          isNull(mailingRecipients.outboundMessageId),
          isNull(mailingRecipients.error),
        ),
      )
      .returning({ personId: mailingRecipients.personId });
    if (failed.length === 0 || disabledBotTitle === undefined) return;
    await deps.alerts.raise(
      "delivery_failed",
      `Рассылка «${preview(mailing.text)}»: бот «${disabledBotTitle}» отключён, ${failed.length} чел. не получат сообщение. Подключите бота заново на странице «Боты».`,
      `mailing:${mailing.id}:${botId}`,
    );
  }
}
