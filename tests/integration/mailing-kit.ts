// Набор для тестов рассылок: живой диалог из `live-dialog-kit`, сервис рассылок поверх него и люди в базе одной строкой.
import { randomUUID } from "node:crypto";
import type { ChannelAdapters, ChannelKind } from "@/modules/channels";
import { FakeChannel } from "@/modules/channels/fake";
import { bots } from "@/modules/channels/schema";
import { passages, type PassageStatus } from "@/modules/conversations/schema";
import { createMailingJobs, type MailingJobs } from "@/modules/mailings";
import { people } from "@/modules/people/schema";
import type { JobName } from "@/modules/platform/queue";
import { updateSettings } from "@/modules/platform/settings";
import type { TestDatabase } from "./db-helper";
import { KIT_CIPHER, createLiveDialogKit, type LiveDialogKit, type LiveDialogKitOptions } from "./live-dialog-kit";

export interface MailingKit extends LiveDialogKit {
  adapters: ChannelAdapters;
  mailing: MailingJobs;
  /** Человек в базе бота (по умолчанию — бота набора, Telegram). */
  addPerson(options?: { botId?: string; channel?: ChannelKind; blocked?: boolean; name?: string }): Promise<{ id: string; userId: string }>;
  /** Прохождение человека в опубликованном лидмагните набора. */
  addPassage(personId: string, status: PassageStatus): Promise<void>;
  /** Ещё один бот (ВК, Max) с подделкой мессенджера. */
  addBot(channel: ChannelKind): Promise<string>;
  /** Выполняет все задачи, кроме напоминаний, двигая часы к сроку следующей. */
  drainAll(guard?: number): Promise<void>;
  /** Выполняет задачи (кроме напоминаний), чей срок пришёл; часы не трогает. */
  runDueAll(): Promise<void>;
}

export async function createMailingKit(database: TestDatabase, options: LiveDialogKitOptions = {}): Promise<MailingKit> {
  const kit = await createLiveDialogKit(database, { pricePerMillion: 0, ...options });
  await updateSettings(database.db, { alertChatId: "-100-test", monthlyBudgetUsd: null, dailyLimitUsd: "1000" });
  const published = await kit.publish();
  const adapters: ChannelAdapters = {
    telegram: kit.channel,
    vk: new FakeChannel({ kind: "vk", ratePerSecond: 15 }),
    max: new FakeChannel({ kind: "max", ratePerSecond: 25 }),
  };
  const mailing = createMailingJobs({ db: kit.db, queue: kit.queue, clock: kit.clock, adapters, alerts: kit.alerts });

  async function runDueAll(): Promise<void> {
    for (let job = kit.queue.takeDue(); job; job = kit.queue.takeDue()) {
      const payload = job.payload as Record<string, string>;
      const handlers: { [Name in JobName]?: () => Promise<void> } = {
        "mailing-start": () => mailing.start(payload.mailingId!),
        "mailing-batch": () => mailing.batch(payload.mailingId!),
        "outbound-send": () => kit.dialog.sendOutbound(payload.outboundMessageId!),
        "inbound-route": () => kit.dialog.routeInbound(payload.inboundMessageId!),
        "inbound-turn": () => kit.dialog.runTurn(payload.passageId!),
      };
      const handler = handlers[job.name];
      if (!handler) throw new Error(`Нет обработчика задачи ${job.name}`);
      await handler();
    }
  }

  let personCounter = 0;
  return {
    ...kit,
    adapters,
    mailing,
    runDueAll,

    async addPerson({ botId = kit.bot.id, channel = "telegram", blocked = false, name } = {}) {
      const userId = `user-${++personCounter}-${randomUUID().slice(0, 6)}`;
      const [row] = await kit.db
        .insert(people)
        .values({ channel, botId, externalUserId: userId, displayName: name ?? userId, ...(blocked && { blockedAt: kit.clock.now() }) })
        .returning({ id: people.id });
      return { id: row!.id, userId };
    },

    async addPassage(personId, status) {
      await kit.db.insert(passages).values({
        personId,
        leadMagnetId: published.leadMagnetId,
        snapshotId: published.snapshotId,
        chatId: `chat-${randomUUID()}`,
        status,
      });
    },

    async addBot(channel) {
      const tag = randomUUID().slice(0, 8);
      const [row] = await kit.db
        .insert(bots)
        .values({
          channel,
          title: `Бот ${channel} ${tag}`,
          externalId: `ext-${tag}`,
          username: `bot_${tag}`,
          tokenEncrypted: KIT_CIPHER.encrypt(`fake-${tag}`),
          webhookSecret: `secret-${tag}`,
        })
        .returning({ id: bots.id });
      return row!.id;
    },

    async drainAll(guard = 5000) {
      for (let step = 0; step < guard; step++) {
        await runDueAll();
        const next = kit.queue.nextRunAt();
        if (next === undefined) return;
        kit.clock.set(new Date(Math.max(next, kit.clock.now().getTime())));
      }
      throw new Error(`Очередь не опустела за ${guard} шагов`);
    },
  };
}
