// Замер SC-002: сколько секунд человек ждёт ответ консультанта на настоящей модели.
// Ход идёт тем же путём, что в мессенджере (вебхук → очередь → ход консультанта → отправка), канал подделан.
// Модель — основная (DEFAULT_MODEL_CHOICE, с 22.10 сам DeepSeek). Запуск: DEEPSEEK_API_KEY=<ваш ключ> pnpm measure:consultant
// Нужен PostgreSQL из docker-compose.dev.yml. Одна реплика — один вызов модели (всего 10).
import { createTestDatabase } from "../tests/integration/db-helper";
import { createLiveDialogKit } from "../tests/integration/live-dialog-kit";
import { DEFAULT_MODEL_CHOICE, createAppCatalog } from "../src/modules/platform/models-catalog";

const SC002_LIMIT_SECONDS = 15;

const REPLIES = [
  "Я веду курс по фотографии для начинающих",
  "Пока продаю через личные сообщения, на курс приходит человек пять в месяц",
  "Сайта нет, есть канал в телеграме на 800 человек",
  "Боюсь, что людям не хватает времени на обучение",
  "Хочу, чтобы люди сначала попробовали что-то бесплатное",
  "Могу сделать мини-урок про композицию кадра",
  "Думаю, нужна простая подборка из пяти советов",
  "А как понять, что человек готов купить курс?",
  "Лучше всего реагируют на разборы их собственных снимков",
  "Тогда начну с бесплатного разбора одного фото",
];

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) {
  console.error("Не задан DEEPSEEK_API_KEY. Запуск: DEEPSEEK_API_KEY=<ваш ключ> pnpm measure:consultant");
  process.exit(1);
}

const env = { ...process.env, DEEPSEEK_API_KEY: apiKey };
const database = await createTestDatabase();
try {
  const kit = await createLiveDialogKit(database, {
    realModel: { catalog: createAppCatalog(env), choice: DEFAULT_MODEL_CHOICE, env },
  });
  const { code } = await kit.publish({
    instruction:
      "Ты консультант эксперта по онлайн-курсам. Помоги человеку понять, какой следующий шаг сделать для его проекта. " +
      "Задавай по одному вопросу, отвечай коротко и по делу.",
  });
  const person = "latency-person";
  await kit.send(person, `/start ${code}`, { startCode: code });
  await kit.drain();

  const seconds: number[] = [];
  for (const [index, text] of REPLIES.entries()) {
    const startedAt = performance.now();
    await kit.send(person, text);
    await kit.drain();
    const elapsed = (performance.now() - startedAt) / 1000;
    seconds.push(elapsed);
    console.log(`реплика ${index + 1}: ${elapsed.toFixed(2)} с`);
  }

  const sorted = [...seconds].sort((a, b) => a - b);
  const mean = seconds.reduce((sum, value) => sum + value, 0) / seconds.length;
  const median = (sorted[(sorted.length - 1) >> 1]! + sorted[sorted.length >> 1]!) / 2;
  const max = sorted[sorted.length - 1]!;
  console.log(`\nМодель: ${DEFAULT_MODEL_CHOICE.providerId}/${DEFAULT_MODEL_CHOICE.modelId}`);
  console.log(`Реплик: ${seconds.length}, ответов консультанта: ${kit.textsTo(person).length - 1}`);
  console.log(`Среднее: ${mean.toFixed(2)} с, медиана: ${median.toFixed(2)} с, максимум: ${max.toFixed(2)} с`);
  console.log(`SC-002 (среднее < ${SC002_LIMIT_SECONDS} с): ${mean < SC002_LIMIT_SECONDS ? "выполнено" : "НЕ выполнено"}`);
  process.exitCode = mean < SC002_LIMIT_SECONDS ? 0 : 1;
} finally {
  await database.drop();
}
