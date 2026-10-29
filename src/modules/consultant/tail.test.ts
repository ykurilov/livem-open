import { createChatService, createInMemoryChatStorage } from "@ykurilov/agent-chat-core";
import { describe, expect, it } from "vitest";
import { newLeadMagnetSettings, type LeadMagnetSettings } from "../lead-magnets";
import { STUB_MODEL_CHOICE, createAppCatalog, createStubModelCatalog } from "../platform/models-catalog";
import { createScriptedModel } from "../platform/scripted-model";
import { createTurnTails } from "../platform/turn-tails";
import { buildConsultantInstruction, lastReplyRule } from "./instruction";
import { buildConsultantTail, saleTailLine } from "./tail";
import type { SaleAnswer } from "./schema";
import { FIRST_APP_FIELDS, firstAppSettings } from "../flows/first-app.fixture";
import { leadMagnetToFlow } from "../flows/settings-to-flow";

const settings: LeadMagnetSettings = {
  ...newLeadMagnetSettings("Разбор воронки"),
  instruction: "Ты помогаешь эксперту найти слабое место воронки.",
  endCondition: "Человек выбрал следующий шаг",
  maxPersonMessages: 20,
  stages: [
    { id: "intro", name: "Знакомство", instruction: "Узнай имя и нишу.", transitionCondition: "Известны имя и ниша", startDay: null, isSale: false },
    { id: "goal", name: "Цель", instruction: "Узнай цель на квартал.", transitionCondition: "Цель названа", startDay: null, isSale: false },
  ],
};

const day = (number: number, totalDays = 3) => ({ day: number, totalDays, isLastDay: number >= totalDays, dayStartedAt: 0, nextDayStartAt: 0 });
const softPrice: SaleAnswer = { reason: "price", firm: false, softHandled: false, lastOfferDay: 2 };

describe("хвост консультанта", () => {
  it("далеко от предела — хвоста нет: этап, день и рамки дописывает сценарий SDK", () => {
    expect(buildConsultantTail({ settings, personMessageCount: 3 })).toBeNull();
  });

  it("«осталось N сообщений» появляется за 5 до предела", () => {
    expect(buildConsultantTail({ settings, personMessageCount: 14 })).toBeNull();
    expect(buildConsultantTail({ settings, personMessageCount: 15 })).toMatch(/осталось 5 сообщений/i);
    expect(buildConsultantTail({ settings, personMessageCount: 19 })).toMatch(/осталось 1 сообщени/i);
  });

  it("последнее сообщение — просьба завершить диалог", () => {
    const tail = buildConsultantTail({ settings, personMessageCount: 20 })!;
    expect(tail).toMatch(/последнее сообщение/i);
    expect(tail).toMatch(/заверши/i);
  });

  it("у программы на несколько дней предела сообщений нет: его заменяют рамки дня", () => {
    const program = firstAppSettings();
    expect(buildConsultantTail({ settings: { ...program, flow: leadMagnetToFlow(program, FIRST_APP_FIELDS) }, personMessageCount: 500 })).toBeNull();
  });
});

describe("строка продажи в хвосте", () => {
  it("без отказа и не в «Продаже» — строки нет", () => {
    expect(saleTailLine({ saleAnswer: null, inSale: false, day: day(1) })).toBeNull();
    expect(saleTailLine({ saleAnswer: null, inSale: false, day: day(1), firstReasons: [{ kind: "silence", step: 1 }] })).toBeNull();
  });

  it("утро не последнего дня в «Продаже», на предложение не ответил: курс не предлагать (eval 15.10)", () => {
    const line = saleTailLine({ saleAnswer: null, inSale: true, day: day(2), firstReasons: [{ kind: "morning" }] });
    expect(line).toMatch(/не предлагай/i);
    expect(line).toMatch(/ссылк/i);
  });

  it("утро, в которое «Продажа» только включилась по дню: первое предложение можно", () => {
    const line = saleTailLine({ saleAnswer: null, inSale: true, day: day(2, 4), firstReasons: [{ kind: "transition", stateId: "course" }, { kind: "morning" }] });
    expect(line ?? "").not.toMatch(/не предлагай/i);
    // Сообщение первым по умолчанию не продаёт: разрешение должно прийти явным текстом
    expect(line).toMatch(/в этом сообщении можно[^\n]*предложить[^\n]*один раз/i);
  });

  it("касание после тишины в «Продаже»: курс не предлагать — ни цены, ни ссылки", () => {
    const line = saleTailLine({ saleAnswer: null, inSale: true, day: day(3, 4), firstReasons: [{ kind: "silence", step: 1 }] })!;
    expect(line).toMatch(/не предлагай/i);
    expect(line).toMatch(/ссылк/i);
  });

  it("утро последнего дня — одно предложение с новой стороны можно, даже после тишины и мягкого «нет»", () => {
    const reasons = [{ kind: "morning" as const }, { kind: "silence" as const, step: 2 }];
    const line = saleTailLine({ saleAnswer: softPrice, inSale: true, day: day(3), firstReasons: reasons })!;
    expect(line).toMatch(/последний день/i);
    expect(line).toMatch(/одно предложение/i);
    expect(line).not.toMatch(/не предлагай/i);
  });

  it("утро не последнего дня после мягкого «нет» — в сообщении первым не продавать", () => {
    const line = saleTailLine({ saleAnswer: softPrice, inSale: true, day: day(2), firstReasons: [{ kind: "morning" }] })!;
    expect(line).toMatch(/не продавай/i);
  });

  it("в последний день предложение уже звучало — утром снова не предлагать", () => {
    const offered = { ...softPrice, lastOfferDay: 3 };
    const line = saleTailLine({ saleAnswer: offered, inSale: true, day: day(3), firstReasons: [{ kind: "morning" }] })!;
    expect(line).not.toMatch(/можно одно предложение/i);
  });

  it("твёрдое «нет» — не продавать никогда, и утром последнего дня тоже", () => {
    const firm: SaleAnswer = { reason: "not_interested", firm: true, softHandled: false, lastOfferDay: 2 };
    expect(saleTailLine({ saleAnswer: firm, inSale: true, day: day(3), firstReasons: [{ kind: "morning" }] })).toMatch(/твёрдо отказался/i);
    expect(saleTailLine({ saleAnswer: firm, inSale: true, day: day(2) })).toMatch(/не продавай/i);
  });

  it("живой ответ после первого мягкого «нет» — разобраться один раз; после разобранного — не продавать", () => {
    expect(saleTailLine({ saleAnswer: softPrice, inSale: true, day: day(2) })).toMatch(/разберись в сомнении один раз/i);
    expect(saleTailLine({ saleAnswer: { ...softPrice, softHandled: true }, inSale: true, day: day(2) })).toMatch(/не продавай, пока/i);
  });

  it("без «Дней и времени» последнего дня нет: после тишины — не предлагать", () => {
    expect(saleTailLine({ saleAnswer: null, inSale: true, day: null, firstReasons: [{ kind: "daily", at: "10:00" }, { kind: "silence", step: 3 }] })).toMatch(
      /не предлагай/i,
    );
  });
});

describe("неизменная инструкция консультанта", () => {
  it("консультант — помощник эксперта, а не он сам: в ответе на «кто ты», в answer, даже если лидмагнит говорит от лица эксперта", () => {
    const instruction = buildConsultantInstruction({ ...settings, instruction: "Ты Кирилл, коуч. Пиши от первого лица." });
    expect(instruction).toMatch(/ты помощник эксперта, а не он сам/i);
    expect(instruction).toMatch(/«кто ты»[^\n]*«с кем я говорю»[^\n]*answer/i);
    expect(instruction).toMatch(/даже если[^\n]*от лица эксперта[^\n]*помощник/i);
    expect(instruction).toMatch(/не говори, что ты человек/i);
  });

  it("детали услуги и материалы — только из инструкции", () => {
    expect(buildConsultantInstruction(settings)).toMatch(/как проходит услуга[^\n]*что в ней[^\n]*материал[^\n]*только из инструкции эксперта/i);
  });

  it("поддержка без новых фактов: не описывает за эксперта, как пройдёт встреча, и не обещает от его имени", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/поддерживай словами о чувствах человека, а не новыми фактами/i);
    expect(instruction).toMatch(/что эксперт сделает на встрече[^\n]*кто ещё приходит[^\n]*что не будут продавать/i);
    expect(instruction).toMatch(/спрашивает о том, чего здесь нет[^\n]*уточнит эксперт[^\n]*веди разговор дальше/i);
    expect(instruction).toMatch(/не обещай действий эксперта, которых нет в инструкции[^\n]*подберёт время[^\n]*подстроится под график[^\n]*ответит на созвоне[^\n]*посчитает[^\n]*составит/i);
    expect(instruction).toMatch(/действие прямо написано в инструкции или в прощании[^\n]*можно назвать/i);
    expect(instruction).toMatch(/остальное[^\n]*«это уточнит эксперт»[^\n]*веди разговор дальше/i);
  });

  it("не обещает передать что-то эксперту: на похвалу и отзыв — просто спасибо (eval 14.10: «передам Дмитрию!»)", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/не обещай передать[^\n]*«передам»[^\n]*нет такой возможности/i);
    expect(instruction).toMatch(/похвал[^\n]*отзыв[^\n]*поблагодари/i);
  });

  it("нажим «посчитай»: пример ответа без обещания за эксперта, и на повторный нажим тоже — другими словами", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/настойчиво просит посчитать, составить или подобрать[^\n]*не приписано/i);
    expect(instruction).toMatch(/«Посчитать сам я не могу\. Это уточнит эксперт, на консультации разберёте ваш случай»/);
    expect(instruction).toMatch(/просит снова[^\n]*не обещай за эксперта[^\n]*короче[^\n]*не повторяй слово в слово/i);
  });

  it("о причинах технических проблем не гадает: честно «не знаю» и простое действие", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/причин[^\n]*технических проблем не гадай[^\n]*«не знаю»[^\n]*простое действие/i);
    // Картинку консультант не видит: просить снимок экрана нельзя, только описать словами
    expect(instruction).toMatch(/«не знаю»[^\n]*(?:опис|опиш)[^\n]*словами/i);
    expect(instruction).not.toMatch(/«не знаю»[^\n]*снимок экрана/i);
    // После «не знаю» — без догадок вроде «скорее всего» и «часто бывает», только одно действие
    expect(instruction).toMatch(/«не знаю»[^\n]*без[^\n]*«скорее всего»[^\n]*«часто бывает»[^\n]*одно простое действие/i);
  });

  it("о себе — в одном роде: по имени из инструкции, без имени — без прошедшего времени о себе", () => {
    expect(buildConsultantInstruction(settings)).toMatch(/о себе[^\n]*в одном роде[^\n]*имя[^\n]*род по нему[^\n]*без прошедшего времени/i);
  });

  it("ссылки — только дословно из инструкции, первого сообщения и прощания, в нужный по сценарию момент; не придумывать и не менять", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/ссылки давай только[^\n]*из инструкции эксперта, первого сообщения или прощания[^\n]*дословно[^\n]*когда (?:она|их) нужн/i);
    expect(instruction).toMatch(/не придумывай, не достраивай и не меняй ссылки/i);
    expect(buildConsultantInstruction({ ...settings, videoIds: ["v1"] })).toMatch(/ссылку на ролик в текст не пиши/i);
    expect(buildConsultantInstruction({ ...settings, imageIds: ["i1"] })).toMatch(/ссылку на картинку в текст не пиши/i);
  });

  it("завершение — как обычный ход: сначала finish_dialog, потом последний ответ; прощание приложения модель не повторяет", () => {
    const instruction = buildConsultantInstruction({ ...settings, farewellMessage: "Удачи с курсом!" });
    expect(instruction).not.toMatch(/после вызова ничего не пиши/i);
    expect(instruction).toMatch(/сначала вызови finish_dialog[^\n]*потом[^\n]*последний ответ/i);
    expect(instruction).toMatch(/agreed[^\n]*answer/i);
    expect(instruction).not.toMatch(/пуст/i);
    expect(instruction).toContain("Удачи с курсом!");
  });

  it("итог сначала подтверждает человек: пересказ с вопросом, finish_dialog только после явного согласия", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/finish_dialog пока не вызывай[^\n]*перескажи итог[^\n]*подходит ли/i);
    expect(instruction).toMatch(/только после явного согласия/i);
    expect(instruction).toMatch(/сомнение[^\n]*не согласие[^\n]*проясни/i);
  });

  it("мягкое «вроде подходит» без возражения — согласие; вопрос, не меняющий итог, — ответить и завершить с agreed", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/«вроде подходит»[^\n]*без возражения[^\n]*согласие/i);
    expect(instruction).toMatch(/не меняет итог[^\n]*коротко ответь[^\n]*finish_dialog с agreed/i);
  });

  it("после сомнения или отказа — принять, без вопроса-дожима о шаге и без повтора того же предложения", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/после сомнения, возражения или отказа[^\n]*«не знаю»[^\n]*«дорого»[^\n]*«подумаю»[^\n]*прими/i);
    expect(instruction).toMatch(/не заканчивай[^\n]*«Попробуем\?»[^\n]*«Подойдёт такой шаг\?»/i);
    expect(instruction).toMatch(/снова предлагай шаг, только когда человек сам[^\n]*новый повод/i);
  });

  it("обобщения об эксперте и его клиентах и успокаивающие подробности — тоже факты, без них в инструкции не говорить", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/«обычно»[^\n]*«почти каждый»[^\n]*«чаще всего»[^\n]*тоже факты/i);
    expect(instruction).toMatch(/«никаких обязательств»[^\n]*«это не проблема»/i);
  });

  it("не толкует чувства и не объясняет здоровье: откликается словами человека", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/не объясняй человеку его чувства[^\n]*как устроены тело и здоровье/i);
    expect(instruction).toMatch(/откликнись коротко[^\n]*его же словами/i);
  });

  it("одно сообщение — не больше одного вопроса, второй через «И …?» тоже нельзя; коротко, подробности по запросу", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/не больше одного вопроса[^\n]*«И …\?»/i);
    expect(instruction).toMatch(/подробности[^\n]*когда человек спросит/i);
    expect(instruction).not.toMatch(/один ответ с одним вопросом/i);
  });

  it("не обещает спросить или сделать потом; пообещал — выполняет в следующем сообщении первым делом", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/не обещай сам сделать что-то позже[^\n]*«завтра спрошу»/i);
    expect(instruction).toMatch(/пообещал[^\n]*в следующем своём сообщении[^\n]*раньше других предложений/i);
  });

  it("ответ из инструкции эксперта важнее «уточнит эксперт»: есть хоть частично — назвать; «уточнит» — только чего в текстах нет", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/сначала ищи ответ[^\n]*инструкции эксперта[^\n]*карточке состояния[^\n]*даже частично[^\n]*назови/i);
    expect(instruction).toMatch(/«уточнит эксперт» — только[^\n]*действительно нет/i);
    expect(instruction).toMatch(/«Пробная тренировка бесплатная, около часа\./);
    expect(instruction).not.toMatch(/чего здесь нет, — цена, длительность, формат, бесплатность/i);
  });

  it("возражение против самого шага — тоже сомнение; после «уточнит эксперт» про деньги или условия шаг следом не предлагать", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/возражение против самого шага[^\n]*«мне не встреча нужна, а цифра»[^\n]*тоже сомнение/i);
    expect(instruction).toMatch(/ответил «это уточнит эксперт»[^\n]*не предлагай следом/i);
    // Иначе шаг не звучит вовсе и разговор упирается в предел реплик (eval 19.10: дизайнер, Наталья)
    expect(instruction).toMatch(/новый повод — человек сказал, чего боится или что ему нужно, а шаг это решает[^\n]*одной фразой[^\n]*его словами/i);
  });

  it("свой вопрос без ответа не повторять больше одного раза: сначала ответить на вопрос человека", () => {
    expect(buildConsultantInstruction(settings)).toMatch(/не ответил на твой вопрос[^\n]*сначала ответь на его[^\n]*не повторяй больше одного раза/i);
  });

  it("посторонние просьбы — код, анекдот, перевод — не выполнять даже в шутку: одна добрая фраза и возврат к теме", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/посторонние просьбы[^\n]*код[^\n]*анекдот[^\n]*не выполняй, даже коротко или в шутку/i);
    expect(instruction).toMatch(/одной доброй фразой[^\n]*верни к теме/i);
  });

  it("ответ в answer не спорит с прощанием из настроек", () => {
    expect(buildConsultantInstruction({ ...settings, farewellMessage: "Удачи с курсом!" })).toMatch(/answer[^\n]*не противоречь прощанию/i);
  });

  it("себе не приписывает работу эксперта, сервиса или его агента: не «могу собрать», а «агент соберёт»", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/о себе говори только то, что делаешь сам в переписке[^\n]*«могу собрать»[^\n]*«агент соберёт»/i);
    expect(instruction).not.toMatch(/сделай шаг за человека/i);
  });

  it("как работает сервис или приложение — сколько длится, что появляется сначала — только из инструкции, без «обычно минута-две»", () => {
    expect(buildConsultantInstruction(settings)).toMatch(/как работает сервис или приложение[^\n]*сколько длится[^\n]*«обычно это минута-две»/i);
  });

  it("отказ от шага — без вопроса о шаге и без штампа «что вас останавливает?»; другой вариант того же шага — тот же шаг", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/человек отказался от шага[^\n]*«не пойду»[^\n]*не задавай вопросов о шаге[^\n]*другое время, формат или вариант того же шага — тот же шаг/i);
    expect(instruction).toMatch(/«Что вас останавливает\?»[^\n]*«Что смущает в этих 30 минутах\?»[^\n]*«Что ближе — утро или вечер\?»/);
    expect(instruction).not.toMatch(/Можно один спокойный вопрос о том, что смущает/);
  });

  it("сроки и «набор закрывается» — только дословно из инструкции эксперта и не больше одного раза", () => {
    expect(buildConsultantInstruction(settings)).toMatch(/сроки и ограничения[^\n]*«набор закрывается»[^\n]*дословно[^\n]*не больше одного раза за разговор/i);
  });

  it("о человеке и о том, что сделано, — только из его слов и записанного: «жена» вместо «девушка», несделанная правка — выдумка", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/что уже сделано[^\n]*только то, что человек сказал сам или что записано/i);
    expect(instruction).toMatch(/«вы с женой»[^\n]*правку, которую ты предлагал, а человек не подтвердил/i);
  });

  it("ссылка с подставленным текстом: правило — только если она есть в настройках; ссылку сам не собирать", () => {
    expect(buildConsultantInstruction(settings)).not.toMatch(/text_link/);
    const textLink = { template: "https://appstudio.example.com/?idea={text}&type={type}", types: ["game"], maxTextLength: 450 };
    expect(buildConsultantInstruction({ ...settings, textLink })).toMatch(/https:\/\/appstudio\.example\.com\/\?idea=[^\n]*сам не собирай[^\n]*text_link[^\n]*как есть/i);
  });

  it("живой отклик — про самого человека, без «у многих так» и «это классика»", () => {
    expect(buildConsultantInstruction(settings)).toMatch(/отклик[^\n]*про самого человека[^\n]*«у многих так»[^\n]*«это классика»/i);
  });

  it("пересказ итога — сплошным текстом, без списка и пунктов", () => {
    expect(buildConsultantInstruction(settings)).toMatch(/перескажи итог сплошным текстом[^\n]*без списка/i);
  });

  it("отказ от шага — итог одной фразой и declined, без уговоров и повтора предложения", () => {
    expect(buildConsultantInstruction(settings)).toMatch(
      /отказался от шага[^\n]*finish_dialog с declined[^\n]*одной фразой[^\n]*не уговаривай[^\n]*не повторяй предложение/i,
    );
  });

  it("«подумаю», «не сейчас» и отложенное решение — declined; left — только если человек ушёл или перестал отвечать", () => {
    expect(buildConsultantInstruction(settings)).toMatch(/«подумаю»[^\n]*«не сейчас»[^\n]*declined/i);
    expect(buildConsultantInstruction(settings)).toMatch(/left[^\n]*только[^\n]*перестал отвечать/i);
  });

  it("без согласия завершает, если человек прощается, просит закончить или отказывается продолжать", () => {
    expect(buildConsultantInstruction(settings)).toMatch(/сам прощается[^\n]*отказывается продолжать[^\n]*finish_dialog сразу/i);
  });

  it("последний ответ не повторяет подтверждённый пересказ целиком", () => {
    expect(buildConsultantInstruction(settings)).toMatch(/последний ответ[^\n]*не повторяй/i);
  });

  it("прощание приложения — только когда человек согласился; при отказе или уходе консультант прощается сам без «записал»", () => {
    const instruction = buildConsultantInstruction({ ...settings, farewellMessage: "Удачи с курсом!" });
    expect(instruction).toMatch(/agreed[^\n]*текст[^\n]*не дойдёт/i);
    expect(instruction).toMatch(/declined[^\n]*left[^\n]*попрощайся сам[^\n]*записал/i);
  });

  it("при agreed прощание не пересказывается своими словами; своё прощание при отказе — без нового предложения встречи", () => {
    const instruction = buildConsultantInstruction({ ...settings, farewellMessage: "Удачи с курсом!" });
    expect(instruction).toMatch(/agreed[^\n]*задал вопрос[^\n]*answer/i);
    expect(instruction).toMatch(/сроки и порядок связи[^\n]*не выдумывай[^\n]*эксперт свяжется/i);
    expect(instruction).toMatch(/declined[^\n]*без нового предложения встречи/i);
    expect(lastReplyRule("Удачи с курсом!", "agreed")).toMatch(/answer/);
    expect(lastReplyRule("Удачи с курсом!", "agreed")).not.toMatch(/пуст/i);
    expect(lastReplyRule("Удачи с курсом!", "agreed")).not.toMatch(/одна-две фразы/i);
    expect(lastReplyRule("Удачи с курсом!", "declined")).toMatch(/одной короткой фразой[^\n]*без нового предложения встречи/i);
    expect(lastReplyRule("", "left")).toMatch(/без нового предложения встречи/i);
  });

  it("без прощального сообщения последний ответ консультанта и есть прощание", () => {
    const instruction = buildConsultantInstruction({ ...settings, farewellMessage: "  " });
    expect(instruction).not.toMatch(/не прощайся/i);
    expect(instruction).toMatch(/попрощайся/i);
  });

  it("инструкцию эксперта, этапы и правила сценария добавляет сценарий SDK; здесь — условие завершения", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toContain("Человек выбрал следующий шаг");
    expect(instruction).not.toContain("Ты помогаешь эксперту найти слабое место воронки.");
    expect(instruction).not.toContain("Знакомство");
    expect(instruction).not.toMatch(/go_to_stage|remember|set_time_zone|end_day|side_task/);
  });

  it("сообщение первым приносит новое: идея, подсказка, пример; «вы тут?» нельзя — у всех лидмагнитов", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toMatch(/пишешь первым[^\n]*новое[^\n]*иде[^\n]*подсказк[^\n]*пример/i);
    expect(instruction).toMatch(/«вы тут\?»[^\n]*нельзя/);
  });

  it("системная инструкция побайтно одинакова между ходами, отсчёт — в хвосте последнего сообщения", async () => {
    const scripted = createScriptedModel(() => ({ text: "Хорошо." }));
    const tails = createTurnTails();
    const chat = createChatService({
      storage: createInMemoryChatStorage(),
      catalog: createStubModelCatalog(createAppCatalog({}), scripted.model),
      defaultChoice: STUB_MODEL_CHOICE,
      env: { STUB_MODEL_API_KEY: "test" },
      agent: { instructions: buildConsultantInstruction(settings), stepContext: tails.stepContext, timeZone: "Europe/Moscow" },
    });
    const { id: chatId } = await chat.createChat("person");

    for (const [index, text] of ["Привет", "Хочу продажи"].entries()) {
      tails.set(chatId, buildConsultantTail({ settings, personMessageCount: 18 + index }));
      const stream = await chat.sendMessage("person", chatId, { id: `m${index}`, role: "user", parts: [{ type: "text", text }] });
      await stream.pipeTo(new WritableStream()); // дочитываем поток: ход закончен
    }

    expect(scripted.calls).toHaveLength(2);
    expect(scripted.calls[0]!.system).toBe(scripted.calls[1]!.system);
    expect(scripted.calls[0]!.lastUserText).toMatch(/осталось 2 сообщения/);
    expect(scripted.calls[1]!.lastUserText).toMatch(/осталось 1 сообщение/);
    expect(scripted.calls[1]!.system).not.toMatch(/осталось/);
  });
});
