import { describe, expect, it } from "vitest";
import { createPurchaseTools, type PaymentCheck, type PurchasePort } from "./tools";

describe("инструменты оплаты", () => {
  it("payment_promised: после ссылки не обещать то, чего нет в фактах о продукте — например, вести по курсу самому (eval 21.10)", () => {
    const tools = createPurchaseTools({ port: undefined, chatId: "chat" });
    expect(tools.payment_promised!.description).toMatch(/обещай только то, что есть в фактах о продукте[^\n]*не обещай, что сам поведёшь/i);
  });

  it("payment_check: оплата уже учтена и поздравление было — флаг тоже говорит, что оплата есть", async () => {
    const port: PurchasePort = {
      promised: async () => {},
      check: async (): Promise<PaymentCheck> => ({ kind: "already_congratulated" }),
      tailLine: async () => null,
    };
    const tools = createPurchaseTools({ port, chatId: "chat" });
    const answer = await tools.payment_check!.execute!({} as never, { toolCallId: "call", messages: [], context: {} } as never);
    expect(answer).toMatchObject({ ok: true, paid: true, next: expect.stringMatching(/уже учтена/) });
  });
});
