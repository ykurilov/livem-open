import { describe, expect, it } from "vitest";
import { IMAGE_SIZE_LIMIT, loadImage } from "./image-source";

const URL = "https://sun9-1.userapi.com/photo.jpg";

/** Ответ по частям, без длины в заголовке: сколько прочитано, видно по `pulled`. */
function streamed(chunks: number, chunkSize: number, headers: Record<string, string> = {}) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) return controller.close();
      pulled++;
      controller.enqueue(new Uint8Array(chunkSize));
    },
  });
  return { response: new Response(body, { headers: { "content-type": "image/jpeg", ...headers } }), pulled: () => pulled };
}

describe("картинка по ссылке", () => {
  it("обычная — скачивается целиком", async () => {
    const { response } = streamed(3, 1000);
    const loaded = await loadImage(URL, async () => response, 1000);
    expect(loaded).toMatchObject({ ok: true, image: { filename: "photo.jpg", contentType: "image/jpeg" } });
    if (loaded.ok) expect(loaded.image.bytes.length).toBe(3000);
  });

  it("больше предела по заголовку — отказ без чтения тела", async () => {
    const { response, pulled } = streamed(1, 10, { "content-length": String(IMAGE_SIZE_LIMIT + 1) });
    expect(await loadImage(URL, async () => response, 1000)).toMatchObject({ ok: false, reason: "permanent" });
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  it("без длины в заголовке, но больше предела — чтение обрывается на пределе", async () => {
    const chunk = 1024 * 1024;
    const { response, pulled } = streamed(100, chunk);
    expect(await loadImage(URL, async () => response, 1000)).toMatchObject({ ok: false, reason: "permanent" });
    expect(pulled()).toBeLessThanOrEqual(IMAGE_SIZE_LIMIT / chunk + 2);
  });
});
