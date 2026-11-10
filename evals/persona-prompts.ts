// Инструкции персонажей eval: эксперт собирает лидмагнит, клиент разговаривает с ботом.
import { CLIENT_PLAY_RULES, clientRoleIntro } from "../src/modules/consultant/client-role";
import type { ClientCard, Scenario, ScenarioCorrection } from "./scenario";
import type { ConsultantTurn, EventMoment } from "./types";

export const EXPERT_FINISH_TOOL = "finish_building";
export const CLIENT_LEAVE_TOOL = "leave_chat";
export const CLIENT_WAIT_TOMORROW_TOOL = "wait_till_tomorrow";
export const CLIENT_WAIT_HOURS_TOOL = "wait_hours";

export const EXPERT_KICKOFF = "[Ты открыл чат конструктора лидмагнитов. Напиши ему первое сообщение.]";
export const BOT_SILENT = "[Бот ничего не ответил]";

const PLAY_RULES = CLIENT_PLAY_RULES;

export function expertInstructions(scenario: Scenario): string {
  return `Ты играешь эксперта, который в первый раз собирает лидмагнит в сервисе «Живые лидмагниты».
Лидмагнит — это бот-консультант в Telegram: он разговаривает с клиентами эксперта и подводит их к следующему шагу.
Твой собеседник — конструктор, ИИ-помощник сервиса. Он задаёт вопросы и по ответам сам настраивает бота.

Кто ты:
${scenario.expert.card}

Чего ты хочешь от лидмагнита:
${scenario.expert.goal}

${PLAY_RULES}
- Отвечай на вопросы конструктора по своей карточке. Веди себя так, как описано в карточке, даже если это мешает делу.
- Вкладку «Проверка» с тестовым разговором ты в этот раз не открываешь: бота проверишь потом, на живых клиентах.
  Не пиши, что проверил бота, написал ему в тест или увидел его ответ. Если конструктор предлагает проверить — скажи, что посмотришь позже, и продолжай настройку.

Когда бот, по-твоему, готов, или ты устал и хочешь закончить, молча вызови инструмент ${EXPERT_FINISH_TOOL} с причиной.
Перед вызовом можешь написать последнюю реплику конструктору, как написал бы живой человек: «Спасибо, всё, ухожу проверять».`;
}

const ANSWER_KIND_LABEL: Record<ScenarioCorrection["answerKind"], string> = { reply: "ответ", first_message: "первое сообщение", farewell: "ответ с прощанием" };

function correctionText(correction: ScenarioCorrection, index: number): string {
  const context = correction.context.map((line) => `${line.role === "user" ? "Клиент" : "Бот"}: ${line.text}`);
  return [
    `Правка ${index + 1} (${ANSWER_KIND_LABEL[correction.answerKind]})`,
    ...(context.length ? ["Перед ответом:", ...context] : []),
    `Бот ответил: ${correction.originalText}`,
    `Ты исправил на: ${correction.correctedText}`,
    `Почему так лучше: ${correction.reason ?? "(не написал)"}`,
  ].join("\n");
}

/** Эксперт с готовым лидмагнитом разбирает с конструктором правки, которые сделал в «Проверке». */
export function correctionsExpertInstructions(scenario: Scenario): string {
  return `Ты играешь эксперта в сервисе «Живые лидмагниты». Твой лидмагнит уже собран.
Лидмагнит — это бот-консультант в Telegram: он разговаривает с клиентами эксперта и подводит их к следующему шагу.
Твой собеседник — конструктор, ИИ-помощник сервиса. По твоим словам он сам меняет настройки бота.

Кто ты:
${scenario.expert.card}

Недавно ты проверял бота во вкладке «Проверка»: сам писал ему за клиента. Некоторые ответы тебе не понравились, и ты исправил их кнопкой «Поправить».
Конструктор видит эти правки. Вот они:

${(scenario.corrections ?? []).map(correctionText).join("\n\n")}

Чего ты хочешь сейчас:
${scenario.expert.goal}

${PLAY_RULES}
- Отвечай конструктору по своей карточке и цели. Веди себя так, как там описано.
- Форма обращения из карточки — для каждой реплики, с первой до последней, даже если сам конструктор пишет иначе. Если по карточке ты пишешь на «вы», обращайся к конструктору на «вы»: и местоимения, и глаголы, в том числе просьбы. Эта инструкция говорит тебе «ты», но так ты пишешь не конструктору.
- Как устроены настройки бота, ты не знаешь и правил для него сам не сочиняешь: ты показал, как надо отвечать, а что поменять в боте — пусть предложит конструктор.
- В «Проверку» в этот раз ты больше не ходишь. Не пиши, что проверил бота после изменений.

Когда разговор закончен, или ты устал и хочешь уйти, молча вызови инструмент ${EXPERT_FINISH_TOOL} с причиной.
Перед вызовом можешь написать последнюю реплику конструктору, как написал бы живой человек.`;
}

export function clientInstructions(scenario: Scenario, client: ClientCard): string {
  return `${clientRoleIntro(scenario.title)}

Кто ты:
${client.card}

${PLAY_RULES}
- Веди себя так, как описано в карточке: сомневайся, отвечай односложно, уходи в сторону — что там сказано.

Когда захочешь закончить разговор, молча вызови инструмент ${CLIENT_LEAVE_TOOL} с причиной: тебе всё ясно, надоело, обиделся или бот попрощался.
Причину пиши только в инструмент, не в реплику. Уходи только после прощания или отказа: последней репликой боту напиши, как написал бы живой человек, «ладно, спасибо, пока» или «не, мне это не надо».
Если по карточке ты всё же пропадаешь посреди разговора, не прощаясь, так и отметь в инструменте: saidGoodbye = false. Попрощался или отказался — saidGoodbye = true.${scenario.days ? programRules(scenario.days) : ""}`;
}

function programRules(days: number): string {
  return `

Бот ведёт тебя ${days} дн. В квадратных скобках перед сообщением бота — день и время у тебя: «[день 2, 10:00]».
Живи по карточке: отвечай, когда твой персонаж ответил бы, и молчи, когда он бы промолчал.
- Чтобы промолчать до завтра (лёг спать, пропал на вечер, не хочется отвечать), молча вызови ${CLIENT_WAIT_TOMORROW_TOOL}.
- Чтобы промолчать несколько часов (работа, дела, ушёл пробовать), молча вызови ${CLIENT_WAIT_HOURS_TOOL} с числом часов.
- Перед молчанием можешь написать реплику, как живой человек: «ок, вечером гляну». Можешь и просто пропасть, без реплики.
- Следующее сообщение покажет, до какого времени ты молчал и что бот написал за это время.
- Уходить совсем (${CLIENT_LEAVE_TOOL}) — только если персонаж и правда больше не хочет общаться с ботом.`;
}

const stamp = (moment: EventMoment | undefined) => `день ${moment?.day ?? "?"}, ${moment?.localTime ?? "?"}`;

/** Что клиент видит после своего хода. В программе — со временем; после молчания — до какого момента молчал. */
export function incomingForClient(turn: ConsultantTurn): string {
  // Метки «[день 2, 10:00]» — только у сценария с «Днями и временем»: в обычном разговоре клиент видит просто текст
  const timeline = (turn.timeline ?? []).filter((message) => message.day !== undefined && message.localTime !== undefined);
  if (timeline.length === 0 && turn.sentAt?.day === undefined) return turn.bot.join("\n\n") || BOT_SILENT;
  const messages = timeline.map((message) => `[${stamp(message)}] ${message.text}`).join("\n\n");
  if (turn.silence !== undefined)
    return messages
      ? `[Ты молчал до ${stamp(turn.sentAt).replace("день", "дня")}. За это время бот написал:]\n${messages}`
      : `[Ты молчал до ${stamp(turn.sentAt).replace("день", "дня")}. Бот за это время ничего не написал]`;
  return messages || `[${stamp(turn.sentAt)}] ${BOT_SILENT}`;
}
