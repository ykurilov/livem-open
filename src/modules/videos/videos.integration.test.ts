import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { InvalidVideoError, createVideo, deleteVideo, getVideos, leadMagnetVideoSource, listVideos, updateVideo } from "./index";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

const context = { ownerId: "owner", chatId: "chat" };
const at = new Date("2026-10-05T12:00:00Z");

const sample = {
  title: "Как писать промпты",
  url: "https://youtu.be/aircAruvnKk",
  description: "С чего начать запросы к модели.",
};

describe("архив видео", () => {
  it("сохраняет ролик с длительностью и главами и отдаёт его в списке", async () => {
    const video = await createVideo(database.db, {
      ...sample,
      durationSeconds: 600,
      chapters: [{ title: "Примеры", startSeconds: 200 }],
    });
    expect((await getVideos(database.db, [video.id]))[0]).toMatchObject({
      title: "Как писать промпты",
      url: "https://youtu.be/aircAruvnKk",
      durationSeconds: 600,
      chapters: [{ title: "Примеры", startSeconds: 200 }],
    });
    expect((await listVideos(database.db)).map((item) => item.id)).toContain(video.id);
  });

  it("отклоняет ссылку не с YouTube и не с Kinescope понятным текстом", async () => {
    const attempt = createVideo(database.db, { ...sample, url: "https://vimeo.com/123" });
    await expect(attempt).rejects.toThrow(InvalidVideoError);
    await expect(attempt).rejects.toThrow(/YouTube.*Kinescope/);
  });

  it("требует название и описание", async () => {
    await expect(createVideo(database.db, { ...sample, title: "  " })).rejects.toThrow("Напишите название ролика");
    await expect(createVideo(database.db, { ...sample, description: "" })).rejects.toThrow("Напишите, о чём ролик");
  });

  it("не принимает главу за концом ролика", async () => {
    const attempt = createVideo(database.db, { ...sample, durationSeconds: 100, chapters: [{ title: "Финал", startSeconds: 120 }] });
    await expect(attempt).rejects.toThrow("Глава «Финал» начинается позже конца ролика");
  });

  it("правит ролик", async () => {
    const video = await createVideo(database.db, sample);
    await updateVideo(database.db, video.id, { ...sample, title: "Промпты: основы", url: "https://kinescope.io/abc123" });
    expect((await getVideos(database.db, [video.id]))[0]).toMatchObject({ title: "Промпты: основы", url: "https://kinescope.io/abc123" });
  });

  it("удалённый ролик пропадает из списка и из поиска консультанта", async () => {
    const video = await createVideo(database.db, { ...sample, title: "Удаляемый ролик про воронку" });
    await deleteVideo(database.db, video.id, at);
    expect((await listVideos(database.db)).map((item) => item.id)).not.toContain(video.id);
    const source = leadMagnetVideoSource(database.db, [video.id]);
    expect(await source.search("воронка", context)).toEqual([]);
    expect(await source.get(video.id, context)).toBeUndefined();
  });
});

describe("видео для консультанта лидмагнита", () => {
  it("находит и отдаёт только разрешённые ролики", async () => {
    const allowed = await createVideo(database.db, { ...sample, title: "Продажи без давления", description: "Как продавать мягко." });
    const forbidden = await createVideo(database.db, { ...sample, title: "Продажи в лоб", description: "Жёсткие продажи." });
    const source = leadMagnetVideoSource(database.db, [allowed.id]);

    const found = await source.search("продажи", context);
    expect(found.map((entry) => entry.id)).toEqual([allowed.id]);
    expect(found[0]).toMatchObject({ title: "Продажи без давления", url: sample.url, description: "Как продавать мягко." });

    expect(await source.get(allowed.id, context)).toMatchObject({ id: allowed.id });
    expect(await source.get(forbidden.id, context)).toBeUndefined();
  });

  it("ищет по началам слов и сначала по названию", async () => {
    const byDescription = await createVideo(database.db, { ...sample, title: "Разбор ниши", description: "Про упаковку экспертизы." });
    const byTitle = await createVideo(database.db, { ...sample, title: "Упаковка экспертизы", description: "Пошагово." });
    const source = leadMagnetVideoSource(database.db, [byDescription.id, byTitle.id]);
    expect((await source.search("упаковку", context)).map((entry) => entry.id)).toEqual([byTitle.id, byDescription.id]);
  });

  it("без разрешённых роликов ничего не находит", async () => {
    expect(await leadMagnetVideoSource(database.db, []).search("промпты", context)).toEqual([]);
  });
});
