import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { BASE_SETTINGS, createLiveDialogKit, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { bots } from "../channels/schema";
import { getVersion, newProgramSettings } from "../lead-magnets";
import { countRecipients } from "../mailings";
import { people } from "../people/schema";
import { programStartDate } from "../program";
import { updateSettings } from "../platform/settings";
import { AUTOREPLY_TEXT } from "./router";
import { passages, type PassageStatus } from "./schema";

const POLICY_URL = "https://example.com/privacy";
const DAY = 24 * 60 * 60_000;

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;

beforeAll(async () => {
  database = await createTestDatabase();
  await updateSettings(database.db, { privacyPolicyUrl: POLICY_URL });
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database);
  person = `user-${randomUUID().slice(0, 8)}`;
});

async function start(code: string) {
  await kit.send(person, `/start ${code}`, { startCode: code });
  await kit.drain();
}

async function say(text: string) {
  await kit.send(person, text);
  await kit.drain();
}

describe("маршрутизация входящих", () => {
  it("код ссылки — прохождение на снимке этого лидмагнита и первое сообщение со ссылкой на политику", async () => {
    const lead = await kit.publish({ firstMessage: "Здравствуйте! Что у вас за бизнес?" });
    await start(lead.code);

    const [passage] = await kit.passagesOf(person);
    expect(passage).toMatchObject({ leadMagnetId: lead.leadMagnetId, snapshotId: lead.snapshotId, status: "active" });
    expect((await getVersion(database.db, lead.snapshotId))?.isSnapshot).toBe(true);

    const [first] = kit.textsTo(person);
    expect(kit.textsTo(person)).toHaveLength(1);
    expect(first).toContain("Здравствуйте! Что у вас за бизнес?");
    expect(first).toContain(POLICY_URL);
    expect(kit.calls).toHaveLength(0);

    const person_ = await kit.personOf(person);
    expect(person_).toMatchObject({ channel: "telegram", botId: kit.bot.id, displayName: `Человек ${person}` });
  });

  it("сообщение после завершения — автоответ без модели, раз в сутки, и не в день ручного ответа", async () => {
    const lead = await kit.publish();
    await start(lead.code);
    await say("Я готов, спасибо");
    expect((await kit.passagesOf(person))[0]!.status).toBe("completed");
    const callsAfterFinish = kit.calls.length;
    const sentAfterFinish = kit.textsTo(person).length;

    await say("Ещё вопрос");
    expect(kit.textsTo(person).slice(sentAfterFinish)).toEqual([AUTOREPLY_TEXT]);
    expect(AUTOREPLY_TEXT).toBe("Спасибо! Сейчас пока не могу говорить, но в ближайшее время я с вами свяжусь!");

    await say("И ещё");
    expect(kit.textsTo(person).slice(sentAfterFinish)).toHaveLength(1);
    expect(kit.calls).toHaveLength(callsAfterFinish);
    const routes = (await kit.inboundOf(person)).slice(-2).map((row) => row.route);
    expect(routes).toEqual(["inbox", "inbox"]);

    // Новые сутки — снова автоответ
    kit.clock.advance(DAY);
    await say("Доброе утро");
    expect(kit.textsTo(person).slice(sentAfterFinish)).toEqual([AUTOREPLY_TEXT, AUTOREPLY_TEXT]);

    // Эксперт сегодня ответил сам — автоответа нет
    kit.clock.advance(DAY);
    const personRow = (await kit.personOf(person))!;
    await database.db
      .update(people)
      .set({ lastManualReplyOn: kit.clock.mskDate() })
      .where(eq(people.id, personRow.id));
    await say("Спасибо за ответ");
    expect(kit.textsTo(person).slice(sentAfterFinish)).toHaveLength(2);
    expect(kit.calls).toHaveLength(callsAfterFinish);
  });

  it("ссылка другого лидмагнита посреди разговора — старое прохождение не завершено, новое стартует", async () => {
    const first = await kit.publish({ firstMessage: "Первый лидмагнит" });
    const second = await kit.publish({ firstMessage: "Второй лидмагнит" });
    await start(first.code);
    await say("Я дизайнер");

    await start(second.code);

    const [old, current] = await kit.passagesOf(person);
    expect(old).toMatchObject({ leadMagnetId: first.leadMagnetId, status: "not_completed" });
    expect(old!.endedAt).not.toBeNull();
    expect(current).toMatchObject({ leadMagnetId: second.leadMagnetId, status: "active" });
    expect(current!.chatId).not.toBe(old!.chatId);
    expect(kit.textsTo(person).at(-1)).toContain("Второй лидмагнит");
  });

  it("та же ссылка посреди разговора — разговор продолжается, первое сообщение не повторяется", async () => {
    const lead = await kit.publish();
    await start(lead.code);
    await say("Я дизайнер");
    const sent = kit.textsTo(person).length;

    await start(lead.code);

    expect(await kit.passagesOf(person)).toHaveLength(1);
    expect(kit.textsTo(person)).toHaveLength(sent);
    expect((await kit.inboundOf(person)).at(-1)!.route).toBe("ignored");
  });

  it("после завершения ссылка начинает лидмагнит заново", async () => {
    const lead = await kit.publish();
    await start(lead.code);
    await say("Готов");
    await start(lead.code);

    const statuses = (await kit.passagesOf(person)).map((passage) => passage.status);
    expect(statuses).toEqual(["completed", "active"]);
  });

  it("без кода и без разговора: режим «ничего» — во «Входящие» молча; неизвестный код — как без кода", async () => {
    await kit.publish();
    await say("Здравствуйте");
    await kit.send(person, "/start nosuchcode", { startCode: "nosuchcode" });
    await kit.drain();

    expect(kit.textsTo(person)).toEqual([]);
    expect(await kit.passagesOf(person)).toEqual([]);
    expect((await kit.inboundOf(person)).map((row) => row.route)).toEqual(["inbox", "inbox"]);
  });

  it("без кода и без разговора: режим «лидмагнит по умолчанию» — начинает его", async () => {
    const lead = await kit.publish({ firstMessage: "Лидмагнит по умолчанию" });
    await database.db
      .update(bots)
      .set({ noCodeMode: "default", defaultLeadMagnetId: lead.leadMagnetId })
      .where(eq(bots.id, kit.bot.id));

    await kit.send(person, "/start");
    await kit.drain();

    expect((await kit.passagesOf(person))[0]).toMatchObject({ leadMagnetId: lead.leadMagnetId, status: "active" });
    expect(kit.textsTo(person)[0]).toContain("Лидмагнит по умолчанию");
  });

  it("человек заблокировал бота — пометка у человека, прохождение «заблокировано»; разблокировал — пометка снята", async () => {
    const lead = await kit.publish();
    await start(lead.code);

    await kit.webhook([{ type: "blocked", dedupeKey: `${person}-blocked`, userId: person }]);
    await kit.drain();
    expect((await kit.personOf(person))!.blockedAt).not.toBeNull();
    expect((await kit.passagesOf(person))[0]!.status).toBe("blocked");

    await kit.webhook([{ type: "unblocked", dedupeKey: `${person}-unblocked`, userId: person }]);
    await kit.drain();
    expect((await kit.personOf(person))!.blockedAt).toBeNull();
  });

  it("политика не задана — первое сообщение уходит без неё", async () => {
    await updateSettings(database.db, { privacyPolicyUrl: null });
    try {
      const lead = await kit.publish();
      await start(lead.code);
      expect(kit.textsTo(person)).toEqual([BASE_SETTINGS.firstMessage]);
    } finally {
      await updateSettings(database.db, { privacyPolicyUrl: POLICY_URL });
    }
  });

  describe("многодневная программа", () => {
    const programSettings = () => ({ program: newProgramSettings(3) });

    async function setStatus(status: PassageStatus) {
      const [passage] = await kit.passagesOf(person);
      await database.db.update(passages).set({ status, endedAt: kit.clock.now(), nextReminderAt: null }).where(eq(passages.id, passage!.id));
    }

    it("старт: дата дня 1 — по поясу человека, пока пояс неизвестен — по Москве", async () => {
      // 20:30 UTC: в Москве ещё 1 октября (23:30), во Владивостоке уже 2 октября (06:30)
      kit.clock.set(new Date("2026-10-01T20:30:00Z"));
      const lead = await kit.publish(programSettings());

      await start(lead.code);
      expect((await kit.passagesOf(person))[0]!.programStartDate).toBe("2026-10-01");

      const vladivostok = `user-${randomUUID().slice(0, 8)}`;
      await kit.send(vladivostok, "Здравствуйте");
      await kit.drain();
      await database.db.update(people).set({ timeZone: "Asia/Vladivostok" }).where(eq(people.id, (await kit.personOf(vladivostok))!.id));
      await kit.send(vladivostok, `/start ${lead.code}`, { startCode: lead.code });
      await kit.drain();
      expect((await kit.passagesOf(vladivostok))[0]!.programStartDate).toBe("2026-10-02");
    });

    it("лидмагнит без программы дату дня 1 не пишет", async () => {
      const lead = await kit.publish();
      await start(lead.code);
      expect((await kit.passagesOf(person))[0]!.programStartDate).toBeNull();
    });

    it.each(["completed", "term_ended", "blocked"] as const)(
      "ссылка лидмагнита, чья программа закончилась (%s), программу заново не начинает: сообщение во «Входящие»",
      async (status) => {
        const lead = await kit.publish(programSettings());
        await start(lead.code);
        await setStatus(status);
        const sent = kit.textsTo(person).length;

        await start(lead.code);

        expect(await kit.passagesOf(person)).toHaveLength(1);
        expect(kit.textsTo(person)).toHaveLength(sent);
        expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox", startedPassage: false });
      },
    );

    it("программа, брошенная ради другого лидмагнита, по ссылке начинается заново", async () => {
      const program = await kit.publish(programSettings());
      const other = await kit.publish({ firstMessage: "Другой лидмагнит" });
      await start(program.code);
      await start(other.code);
      kit.clock.advance(DAY);

      await start(program.code);

      const rows = await kit.passagesOf(person);
      expect(rows.map((row) => [row.leadMagnetId, row.status])).toEqual([
        [program.leadMagnetId, "not_completed"],
        [other.leadMagnetId, "not_completed"],
        [program.leadMagnetId, "active"],
      ]);
      expect(rows[2]!.programStartDate).toBe(programStartDate(kit.clock.now(), null));
    });

    it("закончившаяся программа не мешает идущему разговору в другом лидмагните", async () => {
      const program = await kit.publish(programSettings());
      const other = await kit.publish({ firstMessage: "Другой лидмагнит" });
      await start(program.code);
      await setStatus("term_ended");
      await start(other.code);

      await start(program.code);

      const rows = await kit.passagesOf(person);
      expect(rows.map((row) => row.status)).toEqual(["term_ended", "active"]);
      expect(rows[1]!.leadMagnetId).toBe(other.leadMagnetId);
      expect((await kit.inboundOf(person)).at(-1)!.route).toBe("inbox");
    });

    it("после «срок вышел» сообщение человека — во «Входящие», автоответ раз в сутки, модель не зовётся", async () => {
      const lead = await kit.publish(programSettings());
      await start(lead.code);
      await setStatus("term_ended");
      const calls = kit.calls.length;
      const sent = kit.textsTo(person).length;

      await say("А что дальше?");
      expect(kit.textsTo(person).slice(sent)).toEqual([AUTOREPLY_TEXT]);
      await say("Алло?");
      expect(kit.textsTo(person).slice(sent)).toHaveLength(1);
      expect((await kit.inboundOf(person)).slice(-2).map((row) => row.route)).toEqual(["inbox", "inbox"]);
      expect(kit.calls).toHaveLength(calls);

      kit.clock.advance(DAY);
      await say("Доброе утро");
      expect(kit.textsTo(person).slice(sent)).toEqual([AUTOREPLY_TEXT, AUTOREPLY_TEXT]);
    });

    it("закончившаяся программа лидмагнита без программы по-прежнему перезапускается ссылкой", async () => {
      const lead = await kit.publish();
      await start(lead.code);
      await setStatus("term_ended");
      await start(lead.code);
      expect((await kit.passagesOf(person)).map((row) => row.status)).toEqual(["term_ended", "active"]);
    });
  });
});
