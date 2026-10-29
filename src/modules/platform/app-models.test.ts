import { describe, expect, it } from "vitest";
import { loadAppModels } from "./app-models";
import { STUB_MODEL_CHOICE } from "./models-catalog";

describe("модели приложения", () => {
  it("подставная модель включается переменной вне продакшена", async () => {
    const models = await loadAppModels({ NODE_ENV: "test", STUB_MODEL: "scripted" });
    expect(models.constructorChoice).toEqual(STUB_MODEL_CHOICE);
  });

  it("в продакшене подставная модель запрещена: ошибка, а не тихая подмена", async () => {
    await expect(loadAppModels({ NODE_ENV: "production", STUB_MODEL: "scripted" })).rejects.toThrow(/STUB_MODEL/);
  });

  it("в продакшене без STUB_MODEL — настоящие модели", async () => {
    const models = await loadAppModels({ NODE_ENV: "production" });
    expect(models.constructorChoice.providerId).toBe("deepseek");
  });
});
