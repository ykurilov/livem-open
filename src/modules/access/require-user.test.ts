import { describe, expect, it } from "vitest";
import { AccessError, accessErrorResponse, requireUserFromCookie } from "./require-user";

const allowedEmails = new Set(["expert@example.com"]);
const sessionUser = { id: "u1", email: "Expert@Example.com", name: "Эксперт", roles: [] };

describe("requireUser", () => {
  it("возвращает пользователя из списка", async () => {
    const user = await requireUserFromCookie("cookie", { allowedEmails, getUser: async () => sessionUser });
    expect(user).toMatchObject({ id: "u1", email: "expert@example.com", name: "Эксперт" });
  });

  it("без входа — ошибка 401", async () => {
    const error = await requireUserFromCookie(null, { allowedEmails, getUser: async () => null }).catch((e) => e);
    expect(error).toBeInstanceOf(AccessError);
    expect(error.status).toBe(401);
  });

  it("вошёл, но адреса нет в списке — ошибка 403", async () => {
    const error = await requireUserFromCookie("cookie", {
      allowedEmails,
      getUser: async () => ({ ...sessionUser, email: "stranger@example.com" }),
    }).catch((e) => e);
    expect(error.status).toBe(403);
  });

  it("ошибка доступа превращается в ответ с тем же кодом", async () => {
    const response = accessErrorResponse(new AccessError(403));
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: "forbidden" });
  });

  it("чужие ошибки не маскируются под ответ", () => {
    expect(accessErrorResponse(new Error("база упала"))).toBeNull();
  });
});
