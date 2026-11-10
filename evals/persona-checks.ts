// Держал ли персонаж роль — то, что видно кодом. Сбой персонажа — не провал агента: такой разговор не годится для оценки.
import { CLIENT_LEAVE_TOOL, CLIENT_WAIT_HOURS_TOOL, CLIENT_WAIT_TOMORROW_TOOL, EXPERT_FINISH_TOOL } from "./persona-prompts";
import { foreignSentences } from "./persona";
import type { CheckResult, ClientRun, ScenarioRun } from "./types";

const PERSONA_TOOLS = [EXPERT_FINISH_TOOL, CLIENT_LEAVE_TOOL, CLIENT_WAIT_TOMORROW_TOOL, CLIENT_WAIT_HOURS_TOOL];
/** Строка от имени собеседника: «Бот: …», «Консультант: …» — персонаж пишет за обоих. */
const SPEAKS_FOR_OTHER = /^\s*(?:бот|консультант|конструктор|ассистент|помощник|клиент|эксперт)\s*:/im;
/** Ремарка вместо реплики: «*уходит*», «(молчит)», «[закрывает чат]». */
const STAGE_DIRECTION = /^\s*(?:\*[^*\n]+\*|\([^()\n]*(?:уход|молч|закрыва|выход|пишет|думает)[^()\n]*\)|\[[^\]\n]+\])\s*$/im;
const OUT_OF_ROLE = /языков(?:ая|ой) модел|как ИИ(?![А-Яа-яЁё])|(?<![А-Яа-яЁё])я\s*[—-]?\s*ИИ(?![А-Яа-яЁё])|искусственный интеллект,? (?:и|я)|мо(?:я|ей) рол[ьи]|по карточке|(?:мой|моего|моему|твой|мне как) персонаж|\(\s*персонаж|персонаж(?:у|а)? (?:бы|должен|должна|по сценари)|ролев(?:ая|ой) игр|это (?:тест|проверка) (?:бота|eval)/i;
/** Эксперт пишет, что проверил бота во вкладке «Проверка», а он её в прогоне не открывает. В разборе правок — открывал. */
const EXPERT_TESTED = /(?:проверил|проверила|протестировал|протестировала|написал|написала)\w*\s+(?:бот[ауе]?|ему|в тест|в «?проверк)|в тесте (?:бот|он) /i;
const GOODBYE = /(?:^|[.!?,]\s*)пока[\s.!)]*$|(?<![А-Яа-яЁё])(?:пока-пока|до свидания|всего (?:доброго|хорошего)|прощайте|удачи|не надо|не нужно|не интересно|не буду)(?![А-Яа-яЁё])/im;
const REPEATS_IN_A_ROW = 3;
/** Карточка велит писать конструктору на «вы». */
const CARD_FORMAL = /на «вы»|на «ты» не переход/i;
/**
 * Обращение на «ты»: местоимения второго лица единственного числа, глагол второго лица («можешь», «сделаешь») и
 * повелительное наклонение из закрытого списка — формы, у которых на «вы» есть окончание «-те».
 */
const INFORMAL_ADDRESS = new RegExp(
  "(?<![А-Яа-яЁё])(?:" +
    [
      "ты|тебя|тебе|тобой|твой|твоя|твоё|твое|твои|твоего|твоей|твоему|твоим|твоих|твою",
      "[А-Яа-яЁё]{3,}(?:ешь|ёшь|ишь)",
      "(?:по)?смотри|глянь|взгляни|гляди|слушай|послушай|давай|дай|подожди|жди|учти|представь|подумай",
      "(?:на|за|до|пере)?пиши|записывай|(?:с|пере)?делай|поправь|исправь|убери|оставь|добавь|верни|замени|поменяй",
      "скажи|покажи|предложи|объясни|проверь|прочитай|почитай",
    ].join("|") +
    ")(?![А-Яа-яЁё])",
  "i",
);
/** Цитаты в «ёлочках» — чужие слова, например ответ бота, а не обращение к собеседнику. */
const withoutQuotes = (text: string) => text.replace(/«[^«»]*»/g, "");

const quote = (text: string, max = 100) => `«${text.length > max ? `${text.slice(0, max)}…` : text}»`;

/** Что не так с репликами персонажа: по номеру реплики, с цитатой. */
function replyProblems(replies: string[], { expert, tested = false, formal = false }: { expert: boolean; tested?: boolean; formal?: boolean }): string[] {
  const problems: string[] = [];
  replies.forEach((text, index) => {
    const at = `реплика ${index + 1}`;
    const foreign = foreignSentences(text);
    if (foreign.length) problems.push(`${at}: не по-русски ${quote(foreign[0]!)}`);
    if (SPEAKS_FOR_OTHER.test(text)) problems.push(`${at}: пишет за собеседника ${quote(text)}`);
    if (STAGE_DIRECTION.test(text)) problems.push(`${at}: ремарка вместо реплики ${quote(text)}`);
    if (OUT_OF_ROLE.test(text)) problems.push(`${at}: вышел из роли ${quote(text)}`);
    const tool = PERSONA_TOOLS.find((name) => text.includes(name));
    if (tool) problems.push(`${at}: называет инструмент ${tool} ${quote(text)}`);
    if (formal && INFORMAL_ADDRESS.test(withoutQuotes(text))) problems.push(`${at}: по карточке пишет на «вы», а перешёл на «ты» ${quote(text)}`);
    if (expert && !tested && EXPERT_TESTED.test(text)) problems.push(`${at}: пишет, что проверил бота в тесте, а вкладку «Проверка» не открывает ${quote(text)}`);
  });
  const normalized = replies.map((text) => text.trim().toLowerCase().replace(/\s+/g, " "));
  for (let index = REPEATS_IN_A_ROW - 1; index < normalized.length; index++) {
    const run = normalized.slice(index - REPEATS_IN_A_ROW + 1, index + 1);
    if (/[\p{L}]/u.test(run[0]!) && run.every((text) => text === run[0]) && (index === normalized.length - 1 || normalized[index + 1] !== run[0]))
      problems.push(`реплики ${index - REPEATS_IN_A_ROW + 2}–${index + 1}: одно и то же три раза подряд ${quote(replies[index]!)}`);
  }
  return problems;
}

const clientReplies = (client: ClientRun) => client.turns.filter((turn) => turn.silence === undefined && !turn.client.startsWith("/start")).map((turn) => turn.client);

function clientRoleCheck(client: ClientRun): CheckResult {
  const subject = `клиент ${client.index}: ${client.name}`;
  const replies = clientReplies(client);
  const problems = [...replyProblems(replies, { expert: false }), ...(client.personaSlips ?? [])];
  const last = replies.at(-1) ?? "";
  if (client.leftMidConversation && GOODBYE.test(last)) problems.push(`ушёл с отметкой saidGoodbye = false, а последней репликой попрощался или отказался ${quote(last)}`);
  return { id: "persona_client_role", title: "Клиент держал роль", subject, status: problems.length ? "persona_broke" : "pass", details: problems.join("\n") };
}

function expertRoleCheck(run: ScenarioRun): CheckResult {
  const check = (status: CheckResult["status"], details: string): CheckResult => ({ id: "persona_expert_role", title: "Эксперт держал роль", subject: "сценарий", status, details });
  if (run.building.endedBy === "from_file") return check("skip", "лидмагнит из файла, эксперта нет");
  const problems = [...replyProblems(run.building.turns.map((turn) => turn.expert), {
      expert: true,
      tested: run.scenario.kind === "corrections",
      formal: CARD_FORMAL.test(run.scenario.expert.card),
    }), ...(run.building.personaSlips ?? [])];
  return check(problems.length ? "persona_broke" : "pass", problems.join("\n"));
}

export function personaChecks(run: ScenarioRun): CheckResult[] {
  return [expertRoleCheck(run), ...run.clients.map(clientRoleCheck)];
}
