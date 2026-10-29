import { randomInt } from "node:crypto";

/** Без похожих знаков (0/o, 1/l): код могут продиктовать или переписать. */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const TRACKING_CODE_LENGTH = 8;

/** Личный код человека в ссылках продукта: случайный, не id из базы. */
export function newTrackingCode(): string {
  return Array.from({ length: TRACKING_CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}
