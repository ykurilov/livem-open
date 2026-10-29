import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type ImageExtension = "png" | "jpg" | "gif" | "webp";

export interface ImageFileInfo {
  extension: ImageExtension;
  width: number;
  height: number;
}

const u16be = (bytes: Uint8Array, at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
const u16le = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8);
const u24le = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
const u32be = (bytes: Uint8Array, at: number) => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.slice(at, at + length));

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    // Кадр SOF0–SOF15, кроме таблиц DHT (C4), JPG (C8) и DAC (CC): в нём высота и ширина
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) };
    }
    at += 2 + u16be(bytes, at + 2);
  }
  return null;
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X" && bytes.length >= 30) return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  if (chunk === "VP8 " && bytes.length >= 30) return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  if (chunk === "VP8L" && bytes.length >= 25) {
    const [b1, b2, b3, b4] = [bytes[21]!, bytes[22]!, bytes[23]!, bytes[24]!];
    return { width: 1 + (((b2 & 0x3f) << 8) | b1), height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) };
  }
  return null;
}

/** Вид и размеры картинки по первым байтам файла: имени и типу из браузера не верим. Не картинка или битый заголовок — `null`. */
export function readImageFile(bytes: Uint8Array): ImageFileInfo | null {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  let found: ImageFileInfo | null = null;
  if (starts(0x89, 0x50, 0x4e, 0x47) && bytes.length >= 24) found = { extension: "png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
  else if (starts(0xff, 0xd8, 0xff)) {
    const size = jpegSize(bytes);
    found = size && { extension: "jpg", ...size };
  } else if (starts(0x47, 0x49, 0x46, 0x38) && bytes.length >= 10) found = { extension: "gif", width: u16le(bytes, 6), height: u16le(bytes, 8) };
  else if (starts(0x52, 0x49, 0x46, 0x46) && ascii(bytes, 8, 4) === "WEBP") {
    const size = webpSize(bytes);
    found = size && { extension: "webp", ...size };
  }
  return found && found.width > 0 && found.height > 0 ? found : null;
}

/**
 * Самые строгие пределы фото из трёх мессенджеров: Telegram — сумма сторон до 10000 и вытянутость до 20:1, MAX — сторона
 * до 7680, ВКонтакте — сумма сторон до 14000 и до 20:1. Что больше — мессенджер не примет фото.
 */
export const IMAGE_MAX_SIDE = 7680;
export const IMAGE_MAX_SIDES_SUM = 10_000;
export const IMAGE_MAX_ASPECT = 20;

/** Что не так с размерами для фото в мессенджерах и как поправить; размеры подходят — `null`. */
export function imageSizeProblem(width: number, height: number): string | null {
  const long = Math.max(width, height);
  // Длинный скриншот обычно и вытянут, и велик: обрезать его полезнее, чем уменьшать
  if (long / Math.min(width, height) > IMAGE_MAX_ASPECT) {
    return `Картинка слишком вытянутая (${width}×${height}) — обрежьте скриншот: длинная сторона не больше чем в ${IMAGE_MAX_ASPECT} раз длиннее короткой`;
  }
  if (long > IMAGE_MAX_SIDE || width + height > IMAGE_MAX_SIDES_SUM) {
    return `Картинка слишком большая (${width}×${height}) — уменьшите: длинная сторона до ${IMAGE_MAX_SIDE}, сумма сторон до ${IMAGE_MAX_SIDES_SUM}`;
  }
  return null;
}

const IMAGE_FILE_NAME = /^image-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

export const imageFileName = (extension: ImageExtension) => `image-${randomUUID()}.${extension}`;

export const isImageFileName = (name: string) => IMAGE_FILE_NAME.test(name);

/** Адрес картинки архива на своём сайте: его видят экран кабинета и библиотека картинок SDK. */
export const imageUrl = (fileName: string) => `/api/images/${fileName}`;

/** Файл картинки архива на диске; чужое имя (не из архива, с путём) — `null`. */
export function imageFilePath(fileName: string, dir: string): string | null {
  return isImageFileName(fileName) ? join(dir, fileName) : null;
}

export const IMAGE_CONTENT_TYPES: Record<ImageExtension, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
