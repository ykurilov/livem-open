import { describe, expect, it } from "vitest";
import { createPurchaseTools } from "./tools";

describe("инструменты оплаты", () => {
  it("payment_promised: после ссылки не обещать то, чего нет в фактах о продукте — например, вести по курсу самому (eval 21.10)", () => {
    const tools = createPurchaseTools({ port: undefined, chatId: "chat" });
    expect(tools.payment_promised!.description).toMatch(/обещай только то, что есть в фактах о продукте[^\n]*не обещай, что сам поведёшь/i);
  });
});
