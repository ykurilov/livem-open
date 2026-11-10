import { describe, expect, it } from "vitest";
import { redirect } from "next/navigation";
import { ACTION_SEND_FAILED, FORM_SEND_FAILED, isFileTooLarge, keepingFormOnSendFailure } from "./form-upload";

const MB = 1024 * 1024;
const fileOf = (bytes: number) => new File([new Uint8Array(bytes)], "big.png");

describe("размер файла до отправки", () => {
  it("больше предела — слишком большой; ровно предел и без файла — нет", () => {
    expect(isFileTooLarge(fileOf(MB + 1), MB)).toBe(true);
    expect(isFileTooLarge(fileOf(MB), MB)).toBe(false);
    expect(isFileTooLarge(undefined, MB)).toBe(false);
  });
});

describe("отправка формы в действие", () => {
  it("ответ действия доходит как есть", async () => {
    const send = keepingFormOnSendFailure(async (_previous: { error?: string; done?: boolean }) => ({ done: true }));
    await expect(send({}, new FormData())).resolves.toEqual({ done: true });
  });

  it("сеть упала или тело слишком большое — ошибка в форме, а не экран сбоя", async () => {
    const send = keepingFormOnSendFailure(async (_previous: { error?: string }) => {
      throw new TypeError("Failed to fetch");
    });
    await expect(send({}, new FormData())).resolves.toEqual({ error: FORM_SEND_FAILED });
  });

  it("у кнопки без полей — свои слова о сбое", async () => {
    const send = keepingFormOnSendFailure(async (_previous: { error?: string }) => {
      throw new TypeError("Failed to fetch");
    }, ACTION_SEND_FAILED);
    await expect(send({}, new FormData())).resolves.toEqual({ error: ACTION_SEND_FAILED });
  });

  it("переход на другую страницу из действия не перехватывается", async () => {
    const send = keepingFormOnSendFailure(async (_previous: { error?: string }) => redirect("/mailings/1"));
    await expect(send({}, new FormData())).rejects.toThrow("NEXT_REDIRECT");
  });
});
