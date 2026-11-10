import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webChatImageResponse } from "./image";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "web-chat-image-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("картинка в ленте веб-чата", () => {
  it("отдаёт и картинку архива, и картинку рассылки из папки загрузок", async () => {
    for (const name of [`image-${randomUUID()}.png`, `mailing-${randomUUID()}.jpg`]) {
      await writeFile(join(dir, name), "картинка");
      const response = await webChatImageResponse(join("/где-угодно", name), dir);
      expect(response.status, name).toBe(200);
      expect(await response.text()).toBe("картинка");
    }
  });

  it("чужое имя или нет файла — 404", async () => {
    await writeFile(join(dir, "secret.txt"), "секрет");
    expect((await webChatImageResponse(join(dir, "secret.txt"), dir)).status).toBe(404);
    expect((await webChatImageResponse(join(dir, `mailing-${randomUUID()}.png`), dir)).status).toBe(404);
  });
});
