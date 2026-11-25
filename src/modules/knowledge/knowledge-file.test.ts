import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidKnowledgeError, KNOWLEDGE_FILE_MAX_BYTES, KNOWLEDGE_PDF_MAX_BYTES, KNOWLEDGE_PDF_MAX_PAGES, readKnowledgeFile, type KnowledgeFileLimits } from "./index";

const utf8 = (text: string) => new TextEncoder().encode(text);
const fixture = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), "tests/fixtures/knowledge", name)));
const read = async (name: string, bytes: Uint8Array) => (await readKnowledgeFile({ name, bytes })).content;

/** Текст ошибки для эксперта; ошибки не было — тест падает. */
async function problem(file: { name: string; bytes: Uint8Array }, limits?: KnowledgeFileLimits): Promise<string> {
  try {
    await readKnowledgeFile(file, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidKnowledgeError);
    return (error as Error).message;
  }
  throw new Error("ошибки не было");
}

describe("текстовый файл базы знаний", () => {
  it("читает .txt и .md в UTF-8: переводы строк приводит к одному виду, BOM и пустые края убирает", async () => {
    expect(await readKnowledgeFile({ name: "Курс.txt", bytes: utf8("﻿\r\n  Урок 1\r\nПро упаковку\r\n\r\n") })).toEqual({ content: "Урок 1\nПро упаковку", charCount: 19 });
    expect(await read("вопросы.MD", utf8("# Вопросы\n\n- Сколько стоит?"))).toBe("# Вопросы\n\n- Сколько стоит?");
    expect(await read("заметки.markdown", utf8("текст"))).toBe("текст");
  });

  it("файл не в UTF-8 читает как Windows-1251 — так сохраняет «Блокнот» старых Windows", async () => {
    // «Привет» в Windows-1251
    const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    expect(await read("старый.txt", cp1251)).toBe("Привет");
  });

  it("файл в UTF-16 с меткой порядка байтов читает как текст — так сохраняет «Блокнот» в кодировке «Юникод»", async () => {
    const utf16le = new Uint8Array([0xff, 0xfe, ...[..."Привет\r\nмир"].flatMap((char) => [char.charCodeAt(0) & 0xff, char.charCodeAt(0) >> 8])]);
    expect(await read("юникод.txt", utf16le)).toBe("Привет\nмир");
    const utf16be = new Uint8Array([0xfe, 0xff, ...[..."Привет"].flatMap((char) => [char.charCodeAt(0) >> 8, char.charCodeAt(0) & 0xff])]);
    expect(await read("юникод.txt", utf16be)).toBe("Привет");
  });

  it("понятные ошибки: не тот формат, пустой файл, слишком большой файл, двоичные данные", async () => {
    expect(await problem({ name: "курс.docx", bytes: utf8("текст") })).toMatch(/\.txt, \.md или \.pdf/);
    expect(await problem({ name: "пусто.txt", bytes: utf8(" \n\t ") })).toMatch(/пустой/);
    expect(await problem({ name: "большой.txt", bytes: new Uint8Array(KNOWLEDGE_FILE_MAX_BYTES + 1).fill(0x41) })).toMatch(/больше 1 МБ/);
    expect(await problem({ name: "картинка.txt", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x1a]) })).toMatch(/не текст/);
  });
});

describe("PDF базы знаний", () => {
  it("достаёт текст из PDF", async () => {
    expect(await read("Курс.PDF", fixture("курс.pdf"))).toBe("Курс длится шесть недель.\nВторая строка про упаковку.");
  });

  it("PDF без текста (скан, фото страниц) — понятная ошибка, а не пустая база", async () => {
    expect(await problem({ name: "скан.pdf", bytes: fixture("скан.pdf") })).toMatch(/в PDF нет текста/i);
  });

  it("испорченный PDF, PDF под видом PDF и слишком большой PDF — понятные ошибки", async () => {
    expect(await problem({ name: "битый.pdf", bytes: utf8("%PDF-1.4 мусор") })).toMatch(/не получилось прочитать/i);
    expect(await problem({ name: "текст.pdf", bytes: utf8("просто текст") })).toMatch(/не получилось прочитать/i);
    expect(await problem({ name: "огромный.pdf", bytes: new Uint8Array(KNOWLEDGE_PDF_MAX_BYTES + 1) })).toMatch(/PDF больше 10 МБ/);
  });

  it("PDF больше предела страниц и PDF, который читается дольше предела времени, — понятные ошибки, сервер не занят надолго", async () => {
    expect(await problem({ name: "курс.pdf", bytes: fixture("курс.pdf") }, { pdfMaxPages: 0 })).toMatch(/В PDF 1 стр\., а прочитать можно до 0/);
    expect(await problem({ name: "курс.pdf", bytes: fixture("курс.pdf") }, { pdfTimeoutMs: 0 })).toMatch(/читается слишком долго/);
    expect(KNOWLEDGE_PDF_MAX_PAGES).toBeGreaterThanOrEqual(100);
  });
});
