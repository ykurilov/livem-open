import { describe, expect, it } from "vitest";
import { generateEntryCode } from "./links";

describe("код входа лидмагнита", () => {
  it("8 знаков A-Za-z0-9", () => {
    for (let index = 0; index < 2000; index++) expect(generateEntryCode()).toMatch(/^[A-Za-z0-9]{8}$/);
  });
});
