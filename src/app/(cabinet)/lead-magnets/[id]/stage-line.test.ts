import { describe, expect, it } from "vitest";
import { showsStage } from "./stage-line";

const working = (id: string) => ({ id, exits: [{ id: `${id}_finish` }] });
const end = (id: string) => ({ id, exits: [] });

describe("showsStage — этап над перепиской", () => {
  it("один этап разговора и конечные ноды — не показываем: подпись повторяла бы название вкладки", () => {
    expect(showsStage({ states: [working("conversation"), end("final"), end("deadline")] })).toBe(false);
  });

  it("несколько этапов разговора — показываем, где сейчас клиент", () => {
    expect(showsStage({ states: [working("intro"), working("sale"), end("final")] })).toBe(true);
  });
});
