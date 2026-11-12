import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConstructorTools } from "./tools";

type Variant = { properties: Record<string, { const?: string }>; required: string[] };

/** Все виды условия перехода (`when`) из схемы agent-flow SDK, вложенные oneOf — плоским списком. */
function whenVariants(): Variant[] {
  const schemaPath = path.join(process.cwd(), "node_modules/@ykurilov/agent-chat-flows/agent-flow.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const when = schema.properties.states.items.properties.exits.items.properties.when;
  const flat = (node: { oneOf?: unknown[] }): Variant[] => (node.oneOf ? node.oneOf.flatMap((child) => flat(child as { oneOf?: unknown[] })) : [node as Variant]);
  return flat(when);
}

describe("контракт edit_lead_magnet для модели", () => {
  const tool = createConstructorTools({} as never, "lead").edit_lead_magnet!;
  const description = String(tool.description);

  it("описывает каждый вид условия перехода из SDK с его обязательными полями", () => {
    const variants = whenVariants();
    expect(variants.length).toBeGreaterThan(3);
    for (const variant of variants) {
      const type = variant.properties.type!.const!;
      expect(description).toContain(`type:"${type}"`);
      for (const key of variant.required.filter((name) => name !== "type")) expect(description).toMatch(new RegExp(`\\b${key}\\b`));
    }
  });

  it("говорит, что других полей в условии нет", () => {
    expect(description).toMatch(/Других полей в when нет/);
  });
});
