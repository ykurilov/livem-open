import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, defaultConsultantReply, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { updateSettings } from "../platform/settings";
import { QUICK_REPLIES_TOOL } from "./quick-replies";

let database: TestDatabase;
let kit: LiveDialogKit;

beforeAll(async () => {
  database = await createTestDatabase();
  await updateSettings(database.db, { monthlyBudgetUsd: null, dailyLimitUsd: "1000" });
  kit = await createLiveDialogKit(database, { pricePerMillion: 0 });
});

afterAll(async () => {
  await database.drop();
});

const textOf = (message: { role: string; content: unknown } | undefined) =>
  message?.role === "user" ? (message.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("\n") : "";

it("шаг после кнопок: служебные строки в конце запроса — одним блоком SDK с заголовком «не сообщение человека»", async () => {
  const user = `user-${randomUUID().slice(0, 8)}`;
  const lead = await kit.publish({ name: "Кнопки и хвост" });
  kit.reply = (call) => {
    if (!call.lastUserText.includes("Привет")) return defaultConsultantReply(call);
    if (call.lastToolResult === undefined) return { toolCalls: [{ toolName: QUICK_REPLIES_TOOL, input: { replies: ["Да", "Нет"] } }] };
    return { text: "Рад знакомству. Вам удобно начать сегодня?" };
  };
  await kit.send(user, `/start ${lead.code}`, { startCode: lead.code });
  await kit.drain();

  await kit.send(user, "Привет");
  await kit.drain();

  const afterButtons = kit.consultantCalls().find((call) => call.lastUserText.includes("Привет") && call.lastToolResult !== undefined);
  expect(afterButtons).toBeDefined();
  const prompt = afterButtons!.options.prompt;
  const tail = textOf(prompt.at(-1));
  expect(prompt.at(-2)?.role).toBe("tool");
  // Блок и заголовок ставит SDK; наш заголовок не дублирует его
  expect(tail).toMatch(/^<step_context>\n[^\n]*Это не новое сообщение человека[^\n]*\n/);
  expect(tail.trimEnd().endsWith("</step_context>")).toBe(true);
  expect(tail.match(/не новое сообщение человека/g)).toHaveLength(1);
  expect(tail).toContain(`Имя в профиле мессенджера: Человек ${user}`);
  expect(kit.textsTo(user).at(-1)).toContain("Вам удобно начать сегодня?");
});
