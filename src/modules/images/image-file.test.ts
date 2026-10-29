import { describe, expect, it } from "vitest";
import { imageFileName, imageSizeProblem, imageFilePath, imageUrl, readImageFile } from "./index";
import { gifOf, jpegOf, pngOf, webpOf } from "./test-images";

describe("файл картинки", () => {
  it("узнаёт PNG, JPG, GIF и WebP по первым байтам и читает размеры", () => {
    expect(readImageFile(pngOf(1280, 720))).toEqual({ extension: "png", width: 1280, height: 720 });
    expect(readImageFile(jpegOf(800, 600))).toEqual({ extension: "jpg", width: 800, height: 600 });
    expect(readImageFile(gifOf(64, 32))).toEqual({ extension: "gif", width: 64, height: 32 });
    expect(readImageFile(webpOf(1920, 1080))).toEqual({ extension: "webp", width: 1920, height: 1080 });
  });

  it("не картинка или битый заголовок — null", () => {
    expect(readImageFile(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    expect(readImageFile(pngOf(1280, 720).slice(0, 18))).toBeNull();
    expect(readImageFile(pngOf(0, 720))).toBeNull();
  });

  it("размеры, которые примут фото Telegram, MAX и ВКонтакте: сторона до 7680, сумма сторон до 10000, вытянутость до 20:1", () => {
    expect(imageSizeProblem(1280, 720)).toBeNull();
    expect(imageSizeProblem(500, 7680)).toBeNull();
    expect(imageSizeProblem(300, 6000)).toBeNull();
    expect(imageSizeProblem(300, 6001)).toMatch(/вытянутая.*обрежьте/i);
    expect(imageSizeProblem(7681, 1000)).toMatch(/слишком большая.*уменьшите/i);
    expect(imageSizeProblem(5001, 5000)).toMatch(/слишком большая.*уменьшите/i);
    expect(imageSizeProblem(0xffff_fff0, 720)).toMatch(/^Картинка слишком/);
    expect(imageSizeProblem(1000, 21_000)).toMatch(/вытянутая/i);
  });

  it("адрес картинки для экрана и путь к файлу на диске — только для имён архива", () => {
    const name = imageFileName("png");
    expect(name).toMatch(/^image-[0-9a-f-]{36}\.png$/);
    expect(imageUrl(name)).toBe(`/api/images/${name}`);
    expect(imageFilePath(name, "/data/uploads")).toBe(`/data/uploads/${name}`);
    expect(imageFilePath("../secret.png", "/data/uploads")).toBeNull();
    expect(imageFilePath("mailing-1.png", "/data/uploads")).toBeNull();
  });
});
