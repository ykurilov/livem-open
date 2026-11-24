import { describe, expect, it } from "vitest";
import { answerInProgress, personMessagesForTurn, rewoundAnswerId } from "./preview-rewind";

const message = (id: string, role: "user" | "assistant") => ({ id, role, parts: [] }) as never;
// Первым написал агент, дальше две пары «реплика — ответ»
const branch = [message("a0", "assistant"), message("u1", "user"), message("a1", "assistant"), message("u2", "user"), message("a2", "assistant")];

describe("откат «Проверки»: место правки", () => {
  it("правка реплики возвращает к ходу ответа на неё", () => {
    expect(rewoundAnswerId(branch, { editedMessageId: "u1" })).toBe("a1");
    expect(rewoundAnswerId(branch, { editedMessageId: "u2" })).toBe("a2");
  });

  it("«Переделать ответ» возвращает к ходу этого ответа; не ответ агента — места нет", () => {
    expect(rewoundAnswerId(branch, { messageId: "a1" })).toBe("a1");
    expect(rewoundAnswerId(branch, { messageId: "u1" })).toBeNull();
    expect(rewoundAnswerId(branch, { messageId: "нет" })).toBeNull();
  });

  it("у последней реплики без ответа места нет", () => {
    expect(rewoundAnswerId([...branch, message("u3", "user")], { editedMessageId: "u3" })).toBeNull();
  });
});

describe("откат «Проверки»: реплики человека к ходу", () => {
  it("новое сообщение добавляет одну, правка оставляет реплики до правленой и саму правку", () => {
    expect(personMessagesForTurn(branch, { kind: "messages" })).toBe(3);
    expect(personMessagesForTurn(branch, { kind: "edit", editedMessageId: "u1" })).toBe(1);
    expect(personMessagesForTurn(branch, { kind: "edit", editedMessageId: "u2" })).toBe(2);
  });

  it("«Переделать ответ» — реплики до ответа", () => {
    expect(personMessagesForTurn(branch, { kind: "regenerate", messageId: "a1" })).toBe(1);
    expect(personMessagesForTurn(branch, { kind: "regenerate", messageId: "a0" })).toBe(0);
  });
});

describe("откат «Проверки»: ответ ещё идёт", () => {
  it("идущий ответ агента на ветке — правку не откатывать; законченные — можно", () => {
    const status = (id: string, value: string) => ({ id, role: "assistant", parts: [], status: value }) as never;
    expect(answerInProgress(branch)).toBe(false);
    expect(answerInProgress([...branch, status("a3", "streaming")])).toBe(true);
    expect(answerInProgress([...branch, status("a3", "interrupted")])).toBe(false);
  });
});
