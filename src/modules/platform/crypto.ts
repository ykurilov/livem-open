import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT_VERSION = "v1";

export interface TokenCipher {
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
}

/** Шифр токенов ботов: AES-256-GCM, ключ — 32 байта в base64 (`BOT_TOKEN_KEY`). Формат строки: `v1:iv:tag:data`. */
export function createTokenCipher(keyBase64: string): TokenCipher {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`Ключ шифрования должен быть ровно ${KEY_BYTES} байта в base64, получено ${key.length}`);
  }

  return {
    encrypt(plain) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return [FORMAT_VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
    },

    decrypt(encrypted) {
      const [version, iv, tag, data, ...rest] = encrypted.split(":");
      if (version !== FORMAT_VERSION || !iv || !tag || data === undefined || rest.length > 0) {
        throw new Error("Строка не похожа на зашифрованный токен");
      }
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    },
  };
}
