import type { StepContext } from "@ykurilov/agent-chat-core";
import type { FlowRunView } from "@ykurilov/agent-chat-flows";
import { describe, expect, it, vi } from "vitest";
import { consultantStepContext } from "./step-context";

const run = { state: "idea", path: [{ state: "idea", tags: [] }], day: { day: 2, totalDays: 3 } } as unknown as FlowRunView;

function setup() {
  const onFirstReasons = vi.fn();
  const context = consultantStepContext({
    tails: { stepContext: async () => null } as never,
    store: { saleState: async () => null },
    readRun: async () => run,
    onFirstReasons,
  });
  const call = (stepNumber: number, firstReasons?: unknown[]) =>
    (context as StepContext)({ ownerId: "o", chatId: "c1", stepNumber, ...(firstReasons && { firstReasons }) } as never);
  return { call, onFirstReasons };
}

describe("причины «бот написал первым» уходят в «Лог»", () => {
  it("на первом шаге хода — один раз, вместе с днём программы", async () => {
    const { call, onFirstReasons } = setup();
    await call(0, [{ kind: "morning" }]);
    expect(onFirstReasons).toHaveBeenCalledExactlyOnceWith({ chatId: "c1", reasons: [{ kind: "morning" }] });
  });

  it("на следующих шагах того же хода не повторяются", async () => {
    const { call, onFirstReasons } = setup();
    await call(1, [{ kind: "morning" }]);
    expect(onFirstReasons).not.toHaveBeenCalled();
  });

  it("ход на сообщение человека (причин нет) — записи нет", async () => {
    const { call, onFirstReasons } = setup();
    await call(0);
    expect(onFirstReasons).not.toHaveBeenCalled();
  });
});

describe("имя из профиля мессенджера — в хвосте хода", () => {
  function withName(name: string | null) {
    const personNameOf = vi.fn(async () => name);
    const context = consultantStepContext({
      tails: { stepContext: async () => "До конца разговора осталось 3 сообщения человека." } as never,
      store: { saleState: async () => null },
      readRun: async () => run,
      personNameOf,
    });
    const call = (firstReasons?: unknown[]) =>
      (context as StepContext)({ ownerId: "person-1", chatId: "c1", stepNumber: 0, ...(firstReasons && { firstReasons }) } as never);
    return { call, personNameOf };
  }

  it("на ход человека — строка с именем вместе с нашим хвостом", async () => {
    const { call, personNameOf } = withName("Марина Петрова");
    const tail = await call();
    expect(tail).toContain("Имя в профиле мессенджера: Марина Петрова");
    expect(tail).toContain("осталось 3 сообщения");
    expect(personNameOf).toHaveBeenCalledWith("person-1");
  });

  it("на ход «пишет первым» — тоже: утром бот обращается по имени", async () => {
    const { call } = withName("Марина");
    expect(await call([{ kind: "morning" }])).toContain("Имя в профиле мессенджера: Марина");
  });

  it("имени в профиле нет — строки нет", async () => {
    const { call } = withName(null);
    expect(await call()).not.toMatch(/Имя в профиле/);
  });
});
