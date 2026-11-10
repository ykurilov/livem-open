import { describe, expect, it } from "vitest";
import { InvalidKnowledgeError, KNOWLEDGE_FILE_MAX_BYTES, readKnowledgeFile } from "./index";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("текстовый файл базы знаний", () => {
  it("читает .txt и .md в UTF-8: переводы строк приводит к одному виду, BOM и пустые края убирает", () => {
    expect(readKnowledgeFile({ name: "Курс.txt", bytes: utf8("﻿\r\n  Урок 1\r\nПро упаковку\r\n\r\n") })).toEqual({ content: "Урок 1\nПро упаковку", charCount: 19 });
    expect(readKnowledgeFile({ name: "вопросы.MD", bytes: utf8("# Вопросы\n\n- Сколько стоит?") }).content).toBe("# Вопросы\n\n- Сколько стоит?");
    expect(readKnowledgeFile({ name: "заметки.markdown", bytes: utf8("текст") }).content).toBe("текст");
  });

  it("файл не в UTF-8 читает как Windows-1251 — так сохраняет «Блокнот» старых Windows", () => {
    // «Привет» в Windows-1251
    const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    expect(readKnowledgeFile({ name: "старый.txt", bytes: cp1251 }).content).toBe("Привет");
  });

  it("файл в UTF-16 с меткой порядка байтов читает как текст — так сохраняет «Блокнот» в кодировке «Юникод»", () => {
    const utf16le = new Uint8Array([0xff, 0xfe, ...[..."Привет\r\nмир"].flatMap((char) => [char.charCodeAt(0) & 0xff, char.charCodeAt(0) >> 8])]);
    expect(readKnowledgeFile({ name: "юникод.txt", bytes: utf16le }).content).toBe("Привет\nмир");
    const utf16be = new Uint8Array([0xfe, 0xff, ...[..."Привет"].flatMap((char) => [char.charCodeAt(0) >> 8, char.charCodeAt(0) & 0xff])]);
    expect(readKnowledgeFile({ name: "юникод.txt", bytes: utf16be }).content).toBe("Привет");
  });

  it("понятные ошибки: не тот формат, пустой файл, слишком большой файл, двоичные данные", () => {
    const problem = (file: { name: string; bytes: Uint8Array }) => {
      try {
        readKnowledgeFile(file);
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidKnowledgeError);
        return (error as Error).message;
      }
      throw new Error("ошибки не было");
    };
    expect(problem({ name: "курс.docx", bytes: utf8("текст") })).toMatch(/\.txt или \.md/);
    expect(problem({ name: "пусто.txt", bytes: utf8(" \n\t ") })).toMatch(/пустой/);
    expect(problem({ name: "большой.txt", bytes: new Uint8Array(KNOWLEDGE_FILE_MAX_BYTES + 1).fill(0x41) })).toMatch(/больше 1 МБ/);
    expect(problem({ name: "картинка.txt", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x1a]) })).toMatch(/не текст/);
  });
});
