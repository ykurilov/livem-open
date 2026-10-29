import { describe, expect, it } from "vitest";
import { OWN_APP_CRITERION } from "./first-app-confirmations";
import firstApp from "../../../docs/lead-magnets/first-app.json";

/** Тексты «Твоего первого приложения» (docs/lead-magnets/first-app.json), которые правились по живым разговорам. */
const state = (id: string) => firstApp.flow.states.find((item) => item.id === id)!;
const judgeText = (stateId: string, exitId: string) => {
  const when = (state(stateId).exits ?? []).find((exit) => exit.id === exitId)!.when;
  return "text" in when ? when.text : "";
};

describe("«Твоё первое приложение»: тексты по живым разговорам", () => {
  it("публикация засчитывается только по ссылке на приложение самого человека; сомнение помощника — не засчитывать (Max, 20.10: «Колесо ужина» вместо своего)", () => {
    expect(OWN_APP_CRITERION).toMatch(/то самое приложение, которое человек собирал/i);
    expect(OWN_APP_CRITERION).toMatch(/помощник[^.]*сомневается[^.]*или сказал, что[^.]*не то[^.]*не выполнено/i);
    expect(state("result").instructions).toMatch(/не похоже на то, что человек собирал[^.]*сначала спроси/i);
  });

  it("собирает агент App Studio: в нодах, где предлагаются правки и идеи, — «агент соберёт», не «могу собрать»", () => {
    for (const id of ["idea", "build", "result"]) expect(state(id).instructions).toMatch(/«могу собрать»/);
    expect(firstApp.instruction).toMatch(/не пиши «я соберу», «могу собрать»/i);
  });

  it("новая стартовая страница App Studio: ссылка с идеей собирается инструментом по шаблону, тип — из списка сервиса", () => {
    expect(firstApp.textLink).toMatchObject({ template: "https://appstudio.example.com/?idea={text}&type={type}", types: ["game", "app", "site", "tracker", "quiz", "card"], maxTextLength: 1200 });
    expect(firstApp.textLink.say).toMatch(/нажмите «Собрать»/);
  });

  it("путь по шагам как на сайте: «Собрать», вход по почте при окне «Мы сохранили вашу идею!», вопросы с «Решить за меня», «Строим!», карточка «Опубликовать приложение», «Обновить»", () => {
    const text = firstApp.instruction;
    for (const step of ["«Собрать»", "«Мы сохранили вашу идею!»", "«Войти по почте»", "«Получить код»", "«Решить за меня»", "«Свой вариант»", "«Строим!»", "«Опубликовать приложение»", "«Обновить»", "«Чат»", "«Превью»"])
      expect(text, step).toContain(step);
    expect(text).toMatch(/второй раз «Собрать» нажимать не нужно/i);
    expect(text).toMatch(/text_link/);
  });

  it("старого интерфейса нигде нет: поля «Опишите приложение или сайт», «Реши сам», «Опубликовать» вверху справа", () => {
    const all = JSON.stringify(firstApp);
    for (const old of ["Опишите приложение или сайт", "Реши сам", "вверху справа", "справа от чата", "страница «Вход»"]) expect(all, old).not.toContain(old);
  });

  it("ловушки сервиса: не «без регистрации», не точный срок, не «как у профи», идея без входа — не дольше часа; бесплатно в пределах лимита", () => {
    const text = firstApp.instruction;
    expect(text).toMatch(/не обещай[^.]*«без регистрации»[^.]*почта нужна перед сборкой/i);
    expect(text).toMatch(/от минуты до нескольких, игры дольше[^.]*точный срок не обещай/i);
    expect(text).toMatch(/«как у профи»/);
    expect(text).toMatch(/без входа[^.]*не дольше часа/i);
    expect(text).toMatch(/бесплатн[^.]*в пределах лимита/i);
    expect(firstApp.firstMessage).not.toMatch(/\d+\s*(–|-)?\s*\d*\s*минут/);
  });

  it("«Идея» включает первую версию: короткий запрос-идея и одна ссылка с ним — «откройте и нажмите «Собрать»»; не открылась или идея не встала — текст для ручной вставки", () => {
    const card = state("idea").instructions;
    expect(card).toMatch(/text_link/);
    expect(card).toMatch(/откройте[^.]*нажмите «Собрать»/i);
    // eval 21.10: «Запрос готов: <ссылка>» — без «нажмите «Собрать»» человек не знает, что идея сама не отправится
    expect(card).toMatch(/без слов «нажмите «Собрать»» ссылку не давай[^.]*сама не отправится/i);
    expect(card).toMatch(/не открылась или идея не встала[^.]*текст запроса/i);
  });
});

