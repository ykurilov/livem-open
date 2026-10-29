import { headers } from "next/headers";
import { getUser } from "../../auth";
import { parseAllowedEmails } from "./access";
import { requireUserFromCookie, type CabinetUser } from "./require-user";

/**
 * Первая строка каждого server action и обработчика кабинета.
 * Прокси защищает страницы, но server action можно вызвать и напрямую, поэтому проверяем ещё раз.
 */
export async function requireUser(): Promise<CabinetUser> {
  return requireUserFromCookie((await headers()).get("cookie"), {
    allowedEmails: parseAllowedEmails(process.env.ALLOWED_EMAILS),
    getUser: (cookieHeader) => getUser(cookieHeader),
  });
}
