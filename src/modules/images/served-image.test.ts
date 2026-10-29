import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imageFileName, imageResponse } from "./index";
import { pngOf } from "./test-images";

let dir: string;
const name = imageFileName("png");
const bytes = pngOf(10, 10);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "served-image-"));
  await writeFile(join(dir, name), bytes);
  await writeFile(join(dir, "mailing-1.png"), bytes);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("отдача картинки архива", () => {
  it("файл архива — с видом картинки и долгим кэшем: имя файла не меняется", async () => {
    const response = await imageResponse(name, dir);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("чужое имя, путь наружу или нет файла — 404", async () => {
    for (const other of ["mailing-1.png", "../secret.png", imageFileName("png")]) expect((await imageResponse(other, dir)).status).toBe(404);
  });
});
