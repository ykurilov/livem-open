import { headers } from "next/headers";
import { getUser } from "../../auth";
import { parseAllowedEmails } from "./access";
import { cabinetUserFromCookie, requireUserFromCookie, type CabinetUser, type RequireUserDependencies } from "./require-user";

/**
 * Первая строка каждого server action и обработчика кабинета.
 * Прокси защищает страницы, но server action можно вызвать и напрямую, поэтому проверяем ещё раз.
 */
export async function requireUser(): Promise<CabinetUser> {
  return requireUserFromCookie((await headers()).get("cookie"), cabinetAccess());
}

/** Эксперт, вошедший в приложение, на открытой странице; посетитель — `null`. */
export async function currentCabinetUser(): Promise<CabinetUser | null> {
  return cabinetUserFromCookie((await headers()).get("cookie"), cabinetAccess());
}

const cabinetAccess = (): RequireUserDependencies => ({
  allowedEmails: parseAllowedEmails(process.env.ALLOWED_EMAILS),
  getUser: (cookieHeader) => getUser(cookieHeader),
});
