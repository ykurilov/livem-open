import { afterEach, describe, expect, it } from "vitest";
import { sharedPerProcess } from "./process-shared";

const KEY = "livemProcessSharedTest";
const slot = globalThis as typeof globalThis & Record<string, unknown>;

afterEach(() => {
  delete slot[KEY];
});

describe("общий на процесс ресурс", () => {
  it("неудачное открытие не запоминается: следующий вызов открывает заново, удачное — одно на всех", async () => {
    const opened: string[] = [];
    let fail = true;
    const open = async () => {
      if (fail) throw new Error("база ещё не поднялась");
      opened.push("ok");
      return { id: opened.length };
    };

    await expect(sharedPerProcess(KEY, open)).rejects.toThrow("база ещё не поднялась");
    fail = false;
    const first = await sharedPerProcess(KEY, open);
    const second = await sharedPerProcess(KEY, open);
    expect(second).toBe(first);
    expect(opened).toEqual(["ok"]);
  });

  it("вызовы во время открытия ждут ту же попытку", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const open = async () => {
      calls += 1;
      await gate;
      return { calls };
    };
    const a = sharedPerProcess(KEY, open);
    const b = sharedPerProcess(KEY, open);
    release();
    expect(await a).toBe(await b);
    expect(calls).toBe(1);
  });

  it("поздний отказ старой попытки не стирает удачную, занявшую место после неё", async () => {
    let rejectOld!: (error: Error) => void;
    const old = sharedPerProcess(KEY, () => new Promise<object>((_, reject) => (rejectOld = reject)));
    // Место освободили (например, перезагрузка модуля в next dev), новая попытка удалась
    delete slot[KEY];
    const fresh = await sharedPerProcess(KEY, async () => ({ fresh: true }));
    rejectOld(new Error("старая попытка упала"));
    await expect(old).rejects.toThrow("старая попытка упала");
    expect(await sharedPerProcess(KEY, async () => ({ fresh: false }))).toBe(fresh);
  });
});
