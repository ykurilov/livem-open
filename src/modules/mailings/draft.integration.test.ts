import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { MAILING_TEXT_LIMIT, MailingError, MailingImageError, saveMailingDraft, type MailingDraftInput } from "./index";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

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
