import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import type { DatabaseExecutor } from "../platform/db";
import { InvalidImageError, createImage, deleteImage, getImages, leadMagnetImageSource, listImages, updateImage } from "./index";
import { jpegOf, pngOf } from "./test-images";

let database: TestDatabase;
let dir: string;

beforeAll(async () => {
  database = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), "images-"));
});

afterAll(async () => {
  await database.drop();
  await rm(dir, { recursive: true, force: true });
});

const context = { ownerId: "owner", chatId: "chat" };
const at = new Date("2026-10-28T12:00:00Z");

const sample = {
  title: "Где готовое приложение",
  description: "Покажи, когда человек не находит своё приложение после сборки: кнопка в левом меню.",
};
const file = { bytes: pngOf(1280, 720) };

/** База, которая читает, но не записывает картинки. */
function failingWrites(db: DatabaseExecutor): DatabaseExecutor {
  const chain = (): unknown => ({ values: chain, set: chain, where: chain, returning: () => Promise.reject(new Error("база недоступна")) });
  return new Proxy(db, { get: (target, key) => (key === "insert" || key === "update" ? chain : Reflect.get(target, key)) });
}

describe("архив картинок", () => {
  it("сохраняет картинку: файл на диске под новым именем, размеры из файла, в списке — новые сверху", async () => {
    const image = await createImage(database.db, sample, file, dir);
    expect(image).toMatchObject({ title: sample.title, description: sample.description, width: 1280, height: 720 });
    expect(image.fileName).toMatch(/^image-[0-9a-f-]{36}\.png$/);
    expect(new Uint8Array(await readFile(join(dir, image.fileName)))).toEqual(file.bytes);
    const later = await createImage(database.db, { ...sample, title: "Редактор" }, file, dir);
    expect((await listImages(database.db)).map((item) => item.id).slice(0, 2)).toEqual([later.id, image.id]);
  });

  it("требует название, описание и картинку PNG, JPG, GIF или WebP до 10 МБ — понятным текстом, без файла на диске", async () => {
    const before = await readdir(dir);
    await expect(createImage(database.db, { ...sample, title: " " }, file, dir)).rejects.toThrow("Напишите название картинки");
    await expect(createImage(database.db, { ...sample, description: "" }, file, dir)).rejects.toThrow(/когда её показывать/);
    await expect(createImage(database.db, { ...sample, description: "я".repeat(301) }, file, dir)).rejects.toThrow(/длиннее 300/);
    const notImage = createImage(database.db, sample, { bytes: new TextEncoder().encode("<svg/>") }, dir);
    await expect(notImage).rejects.toThrow(InvalidImageError);
    await expect(notImage).rejects.toThrow(/PNG, JPG, GIF или WebP/);
    const huge = new Uint8Array(10 * 1024 * 1024 + 1);
    huge.set(pngOf(10, 10));
    await expect(createImage(database.db, sample, { bytes: huge }, dir)).rejects.toThrow("Картинка больше 10 МБ");
    expect(await readdir(dir)).toEqual(before);
  });

  it("картинку, которую мессенджеры не примут фото, отклоняет понятным текстом: что не так и как исправить", async () => {
    const before = await readdir(dir);
    await expect(createImage(database.db, sample, { bytes: pngOf(1000, 21_000) }, dir)).rejects.toThrow(/вытянутая.*обрежьте/i);
    await expect(createImage(database.db, sample, { bytes: pngOf(6000, 5000) }, dir)).rejects.toThrow(/слишком большая.*уменьшите/i);
    await expect(createImage(database.db, sample, { bytes: pngOf(7700, 1000) }, dir)).rejects.toThrow(/слишком большая.*уменьшите/i);
    const replaced = await createImage(database.db, sample, file, dir);
    await expect(updateImage(database.db, replaced.id, sample, { bytes: pngOf(400, 9000) }, dir)).rejects.toThrow(InvalidImageError);
    expect((await readdir(dir)).sort()).toEqual([...before, replaced.fileName].sort());
    expect(await createImage(database.db, sample, { bytes: pngOf(1000, 7680) }, dir)).toMatchObject({ width: 1000, height: 7680 });
  });

  it("битый заголовок с огромной шириной — понятная ошибка, а не сбой базы", async () => {
    const broken = createImage(database.db, sample, { bytes: pngOf(0xffff_fff0, 720) }, dir);
    await expect(broken).rejects.toThrow(InvalidImageError);
  });

  it("база не записала картинку — новый файл не остаётся на диске; при замене старый файл цел", async () => {
    const image = await createImage(database.db, sample, file, dir);
    const before = await readdir(dir);
    const broken = failingWrites(database.db);
    await expect(createImage(broken, sample, file, dir)).rejects.toThrow("база недоступна");
    await expect(updateImage(broken, image.id, sample, { bytes: jpegOf(800, 600) }, dir)).rejects.toThrow("база недоступна");
    expect((await readdir(dir)).sort()).toEqual(before.sort());
    expect(before).toContain(image.fileName);
  });

  it("правка меняет название и описание; новый файл заменяет картинку, старый остаётся для уже показанных", async () => {
    const image = await createImage(database.db, sample, file, dir);
    const renamed = await updateImage(database.db, image.id, { ...sample, title: "Новое название" }, null, dir);
    expect(renamed).toMatchObject({ title: "Новое название", fileName: image.fileName, width: 1280 });
    const replaced = await updateImage(database.db, image.id, sample, { bytes: jpegOf(800, 600) }, dir);
    expect(replaced).toMatchObject({ width: 800, height: 600 });
    expect(replaced.fileName).toMatch(/\.jpg$/);
    expect(await readdir(dir)).toContain(image.fileName);
  });

  it("удалённая картинка пропадает из архива и из поиска, файл остаётся; правка удалённой — ошибка", async () => {
    const image = await createImage(database.db, sample, file, dir);
    await deleteImage(database.db, image.id, at);
    await deleteImage(database.db, image.id, at);
    expect((await listImages(database.db)).map((item) => item.id)).not.toContain(image.id);
    expect(await getImages(database.db, [image.id])).toEqual([]);
    expect(await readdir(dir)).toContain(image.fileName);
    await expect(updateImage(database.db, image.id, sample, null, dir)).rejects.toThrow("Картинка не найдена");
  });
});

describe("каталог картинок лидмагнита", () => {
  it("находит и отдаёт только разрешённые живые картинки; адрес — свой сайт, подпись для незрячих — описание", async () => {
    const allowed = await createImage(database.db, { title: "Редактор приложения", description: "Покажи, когда человек спрашивает, где редактор." }, file, dir);
    const forbidden = await createImage(database.db, { title: "Редактор секретный", description: "Не для этого лидмагнита." }, file, dir);
    const gone = await createImage(database.db, { title: "Редактор старый", description: "Удалён." }, file, dir);
    await deleteImage(database.db, gone.id, at);
    const source = leadMagnetImageSource(database.db, [allowed.id, gone.id]);

    expect((await source.search("редактор", context)).map((entry) => entry.id)).toEqual([allowed.id]);
    expect(await source.get(allowed.id, context)).toEqual({
      id: allowed.id,
      title: "Редактор приложения",
      alt: "Покажи, когда человек спрашивает, где редактор.",
      description: "Покажи, когда человек спрашивает, где редактор.",
      url: `/api/images/${allowed.fileName}`,
      width: 1280,
      height: 720,
    });
    expect(await source.get(forbidden.id, context)).toBeUndefined();
    expect(await source.get(gone.id, context)).toBeUndefined();
  });
});
