/** Заголовки картинок нужного размера для тестов: разбору хватает начала файла. */

const u32be = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const u16be = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
const u16le = (value: number) => [value & 0xff, (value >>> 8) & 0xff];
const u24le = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

export function pngOf(width: number, height: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...ascii("IHDR"), ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]);
}

export function jpegOf(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, ...u16be(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

export function gifOf(width: number, height: number): Uint8Array {
  return new Uint8Array([...ascii("GIF89a"), ...u16le(width), ...u16le(height), 0, 0, 0]);
}

export function webpOf(width: number, height: number): Uint8Array {
  return new Uint8Array([...ascii("RIFF"), ...u32be(0), ...ascii("WEBP"), ...ascii("VP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
}
