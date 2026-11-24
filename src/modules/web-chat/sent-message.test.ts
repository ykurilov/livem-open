import { describe, expect, it } from "vitest";
import { readSentMessage } from "./sent-message";

const URL_ = "https://app.test/api/web-chat/messages";

describe("сообщение посетителя из запроса", () => {
  it("JSON: текст, свой clientId и вкладка", async () => {
    const message = await readSentMessage(new Request(URL_, { method: "POST", body: JSON.stringify({ text: "Привет", clientId: "c1", code: "K7mP2xQ" }) }));
    expect(message).toEqual({ ok: true, text: "Привет", clientId: "c1", code: "K7mP2xQ" });
  });

  it("без текста — 400; без clientId — новый", async () => {
    expect(await readSentMessage(new Request(URL_, { method: "POST", body: "{}" }))).toMatchObject({ ok: false, status: 400 });
    const message = await readSentMessage(new Request(URL_, { method: "POST", body: JSON.stringify({ text: "Привет" }) }));
    expect(message.ok && message.clientId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("форма: фото с подписью, пустое поле фото не считается", async () => {
    const form = new FormData();
    form.set("text", "Вот");
    form.set("clientId", "c2");
    form.set("photo", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "a.png");
    const message = await readSentMessage(new Request(URL_, { method: "POST", body: form }));
    expect(message).toMatchObject({ ok: true, text: "Вот", clientId: "c2", photo: new Uint8Array([1, 2, 3]) });

    const empty = new FormData();
    empty.set("photo", new Blob([]), "");
    expect(await readSentMessage(new Request(URL_, { method: "POST", body: empty }))).toMatchObject({ ok: true, text: "", photo: undefined });
  });

  it("форма больше 10 МБ — 413 до чтения", async () => {
    const request = new Request(URL_, { method: "POST", body: "x", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(11 * 1024 * 1024) } });
    expect(await readSentMessage(request)).toMatchObject({ ok: false, status: 413 });
  });
});
