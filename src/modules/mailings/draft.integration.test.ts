import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { pngOf } from "../images/test-images";
import { MAILING_TEXT_LIMIT, MailingError, MailingImageError, mailings, saveMailingDraft, type MailingDraftInput } from "./index";

const PNG = pngOf(800, 600);

let database: TestDatabase;
let dir: string;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mailing-uploads-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const draft = (overrides: Partial<MailingDraftInput> = {}): MailingDraftInput => ({
  id: null,
  text: "Привет",
  filter: {},
  testPersonId: null,
  image: null,
  removeImage: false,
  ...overrides,
});

const files = async () => (await readdir(dir)).sort();

describe("картинка черновика на диске", () => {
  it("замена и удаление картинки не оставляют старых файлов", async () => {
    const created = await saveMailingDraft(database.db, draft({ image: { name: "a.png", bytes: PNG } }), dir);
    const first = basename(created.imagePath!);
    expect(await files()).toEqual([first]);

    const replaced = await saveMailingDraft(database.db, draft({ id: created.id, image: { name: "b.png", bytes: PNG } }), dir);
    const second = basename(replaced.imagePath!);
    expect(second).not.toBe(first);
    expect(await files()).toEqual([second]);

    // Без новой картинки и без «убрать» прикреплённая остаётся
    const kept = await saveMailingDraft(database.db, draft({ id: created.id, text: "Новый текст" }), dir);
    expect(kept.imagePath).toBe(replaced.imagePath);
    expect(await files()).toEqual([second]);

    const removed = await saveMailingDraft(database.db, draft({ id: created.id, removeImage: true }), dir);
    expect(removed.imagePath).toBeNull();
    expect(await files()).toEqual([]);
  });

  it("черновик не сохранился — новая картинка удаляется, прежняя остаётся", async () => {
    const created = await saveMailingDraft(database.db, draft({ image: { name: "a.png", bytes: PNG } }), dir);
    const first = basename(created.imagePath!);

    const tooLong = "я".repeat(MAILING_TEXT_LIMIT + 1);
    await expect(
      saveMailingDraft(database.db, draft({ id: created.id, text: tooLong, image: { name: "b.png", bytes: PNG } }), dir),
    ).rejects.toThrow(MailingError);
    await expect(saveMailingDraft(database.db, draft({ text: tooLong, image: { name: "c.png", bytes: PNG } }), dir)).rejects.toThrow(
      MailingError,
    );
    expect(await files()).toEqual([first]);

    await expect(
      saveMailingDraft(database.db, draft({ id: created.id, image: { name: "x.png", bytes: new TextEncoder().encode("не картинка") } }), dir),
    ).rejects.toThrow(MailingImageError);
    expect(await files()).toEqual([first]);
  });

  it("чужой черновик по несуществующему id — ошибка, файл не остаётся", async () => {
    await expect(
      saveMailingDraft(database.db, draft({ id: "00000000-0000-0000-0000-000000000000", image: { name: "a.png", bytes: PNG } }), dir),
    ).rejects.toThrow(MailingError);
    expect(await files()).toEqual([]);
  });
});

describe("повтор отправки новой рассылки после потерянного ответа", () => {
  it("тот же requestId — та же рассылка, а не вторая", async () => {
    const requestId = randomUUID();
    const first = await saveMailingDraft(database.db, draft({ requestId, text: "Первый раз" }), dir);
    expect(first.id).toBe(requestId);
    const again = await saveMailingDraft(database.db, draft({ requestId, text: "Второй раз" }), dir);
    expect(again.id).toBe(requestId);
    expect(again.text).toBe("Второй раз");
    expect(await database.db.select().from(mailings).where(eq(mailings.id, requestId))).toHaveLength(1);
  });

  it("рассылка уже запущена — повтор отдаёт её как есть и не трогает", async () => {
    const requestId = randomUUID();
    await saveMailingDraft(database.db, draft({ requestId, text: "Ушла" }), dir);
    await database.db.update(mailings).set({ status: "scheduled" }).where(eq(mailings.id, requestId));
    const again = await saveMailingDraft(database.db, draft({ requestId, text: "Повтор", image: { name: "a.png", bytes: PNG } }), dir);
    expect(again).toMatchObject({ id: requestId, status: "scheduled", text: "Ушла" });
    expect(await files()).toEqual([]);
  });

  it("вторая одновременная отправка получает рассылку, созданную первой", async () => {
    const requestId = randomUUID();
    const first = await saveMailingDraft(database.db, draft({ requestId, text: "Первая" }), dir);
    // Вторая отправка искала рассылку, пока первая ещё не записала её: первый поиск ничего не находит
    let missed = false;
    const lateDb = new Proxy(database.db, {
      get: (target, key, receiver) =>
        key === "select" && !missed
          ? () => {
              missed = true;
              return { from: () => ({ where: async () => [] }) };
            }
          : Reflect.get(target, key, receiver),
    });
    const second = await saveMailingDraft(lateDb, draft({ requestId, text: "Вторая", image: { name: "a.png", bytes: PNG } }), dir);
    expect(second).toMatchObject({ id: first.id, text: "Первая", imagePath: null });
    expect(await database.db.select().from(mailings).where(eq(mailings.id, requestId))).toHaveLength(1);
    expect(await files()).toEqual([]);
  });
});
