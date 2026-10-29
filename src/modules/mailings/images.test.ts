import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAILING_IMAGE_MAX_BYTES, MailingImageError, removeMailingImage, saveMailingImage, uploadsDir } from "./images";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "uploads-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("картинка рассылки", () => {
  it("сохраняется на диск под новым именем с расширением по содержимому", async () => {
    const path = await saveMailingImage({ name: "../../etc/passwd.png", bytes: PNG }, dir);
    expect(dirname(path)).toBe(dir);
    expect(path).toMatch(/\.png$/);
    expect(new Uint8Array(await readFile(path))).toEqual(PNG);
    expect(await saveMailingImage({ name: "photo", bytes: JPEG }, dir)).toMatch(/\.jpg$/);
  });

  it("не картинку и слишком большой файл не берёт", async () => {
    await expect(saveMailingImage({ name: "a.png", bytes: new TextEncoder().encode("<script>") }, dir)).rejects.toThrow(MailingImageError);
    const big = new Uint8Array(MAILING_IMAGE_MAX_BYTES + 1);
    big.set(PNG);
    await expect(saveMailingImage({ name: "big.png", bytes: big }, dir)).rejects.toThrow(MailingImageError);
  });

  it("папка: UPLOADS_DIR, в продакшене по умолчанию /app/data/uploads", () => {
    expect(uploadsDir({ UPLOADS_DIR: "/tmp/x" })).toBe("/tmp/x");
    expect(uploadsDir({ NODE_ENV: "production" })).toBe("/app/data/uploads");
    expect(uploadsDir({})).toMatch(/data\/uploads$/);
  });

  it("удаляет только файлы из папки картинок; уже удалённый — не ошибка", async () => {
    const path = await saveMailingImage({ name: "a.png", bytes: PNG }, dir);
    await removeMailingImage(path, dir);
    await expect(stat(path)).rejects.toThrow();
    await removeMailingImage(path, dir);

    const outside = join(await mkdtemp(join(tmpdir(), "outside-")), "keep.png");
    await writeFile(outside, PNG);
    await removeMailingImage(outside, dir);
    expect((await stat(outside)).isFile()).toBe(true);
    await rm(dirname(outside), { recursive: true, force: true });
  });
});
