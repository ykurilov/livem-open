import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { passages } from "../conversations/schema";
import { newProgramSettings } from "./settings";
import { listPeople, listPeopleFilterOptions, parsePeopleFilter } from "../people";
import { archiveEntryLink, createLabeledLink, findEntryLinkByCode, listLabeledLinks } from "./links";
import { unpublishLeadMagnet } from "./publish";
import { entryLinks } from "./schema";
import { leadMagnetReport } from "./stats";
import { ENTRY_LABEL_SEPARATOR } from "./start-payload";

let database: TestDatabase;
let kit: LiveDialogKit;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database.drop(); });
beforeEach(async () => { kit = await createLiveDialogKit(database); });

const payload = (code: string, label = "video_01") => `${code}${ENTRY_LABEL_SEPARATOR}${label}`;
async function arrive(code: string, person = randomUUID()) {
  await kit.send(person, `/start ${code}`, { startCode: code });
  await kit.drain();
  return person;
}
const labels = (leadId: string) => database.db.select().from(entryLinks)
  .where(and(eq(entryLinks.leadMagnetId, leadId), isNotNull(entryLinks.label)));

describe("рекламная метка в стартовом параметре", () => {
  it("создаётся при первом начале, видна в отчёте и фильтре без предварительной настройки", async () => {
    const lead = await kit.publish();
    expect(await labels(lead.leadMagnetId)).toEqual([]);
    const user = await arrive(payload(lead.code, "Video_01"));
    const [link] = await labels(lead.leadMagnetId);
    expect(link).toMatchObject({ label: "video_01", code: payload(lead.code), archivedAt: null });
    expect((await kit.passagesOf(user))[0]).toMatchObject({ entryLinkId: link!.id, status: "active" });
    expect((await leadMagnetReport(database.db, lead.leadMagnetId)).byLink).toContainEqual(expect.objectContaining({ linkId: link!.id, label: "video_01", arrived: 1 }));
    expect((await listPeopleFilterOptions(database.db)).links).toContainEqual(expect.objectContaining({ id: link!.id, label: "video_01" }));
    const filtered = await listPeople(database.db, parsePeopleFilter({ linkIds: [link!.id] }));
    expect(filtered.map((row) => row.id)).toEqual([(await kit.personOf(user))!.id]);
  });

  it("метка из 12 символов и максимальная из 41 работают; регистр метки не создаёт дубль", async () => {
    const lead = await kit.publish();
    const first = await arrive(payload(lead.code, "Video_01-ABC"));
    const second = await arrive(payload(lead.code, "VIDEO_01-abc"));
    expect((await kit.passagesOf(first))[0]!.entryLinkId).toBe((await kit.passagesOf(second))[0]!.entryLinkId);
    await arrive(payload(lead.code, "a".repeat(41)));
    expect((await labels(lead.leadMagnetId)).map((link) => link.label).sort()).toEqual(["a".repeat(41), "video_01-abc"]);
  });

  it("параллельные первые входы разных людей с одним именем метки дают одну запись и все прохождения", async () => {
    const lead = await kit.publish();
    const users = Array.from({ length: 6 }, () => randomUUID());
    await Promise.all(users.map((user, i) => {
      const value = payload(lead.code, i % 2 ? "VIDEO_01" : "video_01");
      return kit.send(user, `/start ${value}`, { startCode: value });
    }));
    const messages = await Promise.all(users.map((user) => kit.inboundOf(user)));
    await Promise.all(messages.map(([message]) => kit.dialog.routeInbound(message!.id)));
    await kit.drain();
    const [link] = await labels(lead.leadMagnetId);
    expect(await labels(lead.leadMagnetId)).toHaveLength(1);
    for (const user of users) expect((await kit.passagesOf(user))[0]!.entryLinkId).toBe(link!.id);
    expect((await leadMagnetReport(database.db, lead.leadMagnetId)).byLink.find((row) => row.linkId === link!.id)?.arrived).toBe(6);
  });

  it("повторные старты активного и завершённого диалога не меняют исходный источник и не заводят пустые метки", async () => {
    const lead = await kit.publish();
    const user = await arrive(payload(lead.code, "first"));
    const [original] = await kit.passagesOf(user);
    await arrive(payload(lead.code, "second"), user);
    expect(await kit.passagesOf(user)).toHaveLength(1);
    await kit.send(user, "Готов");
    await kit.drain();
    expect((await kit.passagesOf(user))[0]!.status).toBe("completed");
    // Обычный лидмагнит по старому правилу начинается заново, источник первого входа остаётся прежним.
    await arrive(payload(lead.code, "third"), user);
    expect((await kit.passagesOf(user)).map((row) => row.entryLinkId)).toEqual([original!.entryLinkId, original!.entryLinkId]);
    expect((await labels(lead.leadMagnetId)).map((row) => row.label)).toEqual(["first"]);
  });

  it.each(["completed", "term_ended", "blocked"] as const)("законченная программа (%s) не запускается заново и не создаёт другую метку", async (status) => {
    const lead = await kit.publish({ program: newProgramSettings(3) });
    const user = await arrive(payload(lead.code, "first"));
    const [original] = await kit.passagesOf(user);
    await database.db.update(passages).set({ status, endedAt: kit.clock.now() }).where(eq(passages.id, original!.id));
    await arrive(payload(lead.code, "second"), user);
    expect(await kit.passagesOf(user)).toHaveLength(1);
    expect((await kit.passagesOf(user))[0]!.entryLinkId).toBe(original!.entryLinkId);
    expect((await labels(lead.leadMagnetId)).map((row) => row.label)).toEqual(["first"]);
  });

  it("вход без метки не получает её задним числом после повторного старта", async () => {
    const lead = await kit.publish();
    const user = await arrive(lead.code);
    const main = await findEntryLinkByCode(database.db, lead.code);
    await kit.send(user, "Готов"); await kit.drain();
    await arrive(payload(lead.code), user);
    expect((await kit.passagesOf(user)).map((row) => row.entryLinkId)).toEqual([main!.id, main!.id]);
    expect(await labels(lead.leadMagnetId)).toEqual([]);
  });

  it("переход к другому лидмагниту сохраняет старый источник и записывает новый", async () => {
    const a = await kit.publish(); const b = await kit.publish();
    const user = await arrive(payload(a.code, "first"));
    await arrive(payload(b.code, "second"), user);
    const rows = await kit.passagesOf(user);
    expect(rows.map((row) => row.status)).toEqual(["not_completed", "active"]);
    expect(rows[0]!.entryLinkId).toBe((await labels(a.leadMagnetId))[0]!.id);
    expect(rows[1]!.entryLinkId).toBe((await labels(b.leadMagnetId))[0]!.id);
  });

  it("неизвестный базовый код, короткий старый формат и снятый лидмагнит не создают меток", async () => {
    const lead = await kit.publish();
    expect(await kit.passagesOf(await arrive(payload("NoSuch99")))).toEqual([]);
    expect(await kit.passagesOf(await arrive(`${lead.code}__video_01`))).toEqual([]);
    await unpublishLeadMagnet(database.db, lead.leadMagnetId);
    expect(await kit.passagesOf(await arrive(payload(lead.code)))).toEqual([]);
    expect(await labels(lead.leadMagnetId)).toEqual([]);
  });

  it("суффикс допустим только для основной ссылки; коды ручных меток не становятся основными", async () => {
    const lead = await kit.publish();
    const manual = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "blog" });
    expect(await kit.passagesOf(await arrive(payload(manual.code, "nested")))).toEqual([]);
    expect(await labels(lead.leadMagnetId)).toHaveLength(1);
  });

  it.each(["", "кириллица", "x%20", "a".repeat(42)])("невалидная метка '%s' не блокирует корректный основной код", async (label) => {
    const lead = await kit.publish();
    const user = await arrive(payload(lead.code, label));
    const main = await findEntryLinkByCode(database.db, lead.code);
    expect((await kit.passagesOf(user))[0]!.entryLinkId).toBe(main!.id);
    expect(await labels(lead.leadMagnetId)).toEqual([]);
  });

  it("точная старая ручная ссылка и её архив сохраняют атрибуцию; активное имя объединяется без учёта регистра", async () => {
    const lead = await kit.publish();
    const manual = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "Video_01" });
    const user = await arrive(payload(lead.code));
    expect((await kit.passagesOf(user))[0]!.entryLinkId).toBe(manual.id);
    expect(await labels(lead.leadMagnetId)).toHaveLength(1);
    await archiveEntryLink(database.db, manual.id);
    const late = await arrive(manual.code);
    expect((await kit.passagesOf(late))[0]!.entryLinkId).toBe(manual.id);
    // Составной код не существовал: после архива ручной метки новый вход создаёт действующую метку.
    const fresh = await arrive(payload(lead.code));
    expect((await kit.passagesOf(fresh))[0]!.entryLinkId).not.toBe(manual.id);
    expect(await labels(lead.leadMagnetId)).toHaveLength(2);
  });

  it("архивная автоматическая ссылка сохраняет свою строку, включая смешанный регистр payload", async () => {
    const lead = await kit.publish();
    await arrive(payload(lead.code));
    const [link] = await labels(lead.leadMagnetId);
    await archiveEntryLink(database.db, link!.id);
    const user = await arrive(payload(lead.code, "VIDEO_01"));
    expect((await kit.passagesOf(user))[0]!.entryLinkId).toBe(link!.id);
    expect(await labels(lead.leadMagnetId)).toHaveLength(1);
    expect(await listLabeledLinks(database.db, { telegram: kit.channel }, lead.leadMagnetId)).toEqual([]);
    expect((await leadMagnetReport(database.db, lead.leadMagnetId)).byLink).toContainEqual(expect.objectContaining({ linkId: link!.id, archived: true, arrived: 2 }));
  });
});
