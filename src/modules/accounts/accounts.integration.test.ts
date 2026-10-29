import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { verifyPassword } from "../../auth/password/password-hash";
import { AccountInputError, accountStore, MIN_PASSWORD_LENGTH, setPassword } from "./index";

let database: TestDatabase;
const allowedEmails = new Set(["owner@example.com"]);

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe("учётные записи для входа по паролю", () => {
  it("пароль задаётся только почте из ALLOWED_EMAILS", async () => {
    const error = await setPassword(database.db, { email: "stranger@example.com", password: "long-enough-pass", allowedEmails }).catch((e) => e);
    expect(error).toBeInstanceOf(AccountInputError);
    expect(error.message).toMatch(/ALLOWED_EMAILS/);
    expect(await accountStore(database.db).findByEmail("stranger@example.com")).toBeNull();
  });

  it(`короткий пароль (меньше ${MIN_PASSWORD_LENGTH} знаков) не принимается`, async () => {
    const error = await setPassword(database.db, { email: "owner@example.com", password: "short", allowedEmails }).catch((e) => e);
    expect(error).toBeInstanceOf(AccountInputError);
  });

  it("в базе только хеш; почта без учёта регистра и пробелов", async () => {
    await setPassword(database.db, { email: "  Owner@Example.COM ", password: "first-password-1", allowedEmails });
    const account = await accountStore(database.db).findByEmail("owner@example.com");
    expect(account).toMatchObject({ email: "owner@example.com" });
    expect(account!.passwordHash).not.toContain("first-password-1");
    expect(await verifyPassword("first-password-1", account!.passwordHash)).toBe(true);
  });

  it("повторная команда меняет пароль той же учётной записи", async () => {
    const before = await accountStore(database.db).findByEmail("owner@example.com");
    await setPassword(database.db, { email: "owner@example.com", password: "second-password-2", allowedEmails });
    const after = await accountStore(database.db).findByEmail("owner@example.com");
    expect(after!.id).toBe(before!.id);
    expect(await verifyPassword("first-password-1", after!.passwordHash)).toBe(false);
    expect(await verifyPassword("second-password-2", after!.passwordHash)).toBe(true);
  });
});
