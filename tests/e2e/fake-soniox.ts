// Подставной Soniox для сквозных проверок: настоящий ключ в тестах не нужен. На первый кусок звука отвечает закреплённой
// фразой, на просьбу закончить — меткой `<fin>`, на пустой кадр — концом записи.
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

/** Что «распознаёт» подставной Soniox в любом звуке. */
export const FAKE_SONIOX_PHRASE = "Хочу записаться на консультацию";

export async function startFakeSoniox(): Promise<{ url: string; close(): void }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    let started = false;
    let answered = false;
    socket.on("message", (data, isBinary) => {
      const text = isBinary ? null : data.toString();
      if (!started) {
        started = true;
        return;
      }
      if (text === "") {
        socket.send(JSON.stringify({ tokens: [], finished: true }));
        return socket.close(1000);
      }
      if (text !== null && JSON.parse(text).type === "finalize") {
        socket.send(JSON.stringify({ tokens: [{ text: "<fin>", is_final: true }] }));
        return;
      }
      if (!answered) {
        answered = true;
        socket.send(JSON.stringify({ tokens: [{ text: FAKE_SONIOX_PHRASE, is_final: true }] }));
      }
    });
  });
  const { port } = server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}`, close: () => server.close() };
}
