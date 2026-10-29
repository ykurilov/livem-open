import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/modules/**/schema.ts",
  out: "./drizzle",
  schemaFilter: ["app"],
  migrations: { schema: "app", table: "__migrations" },
});
