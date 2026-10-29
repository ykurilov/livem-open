// Проверки кодом: то, что видно без понимания смысла. Смысл оценивает судья по judge.md.
import type { AgentFlow, FlowSchedule } from "@ykurilov/agent-chat-flows/format";
import { claimsSaved, isSavedEdit } from "@/modules/constructor/save-claim";
import { unknownLinksIn } from "./unknown-links";
import { leadMagnetKnownTexts } from "@/modules/consultant/known-texts";
import { DIALOG_OUTCOMES, type DialogOutcome } from "@/modules/consultant/schema";
import { FIRST_MESSAGES_PER_DAY, FIRST_MESSAGES_QUIET_HOURS, SALE_TAG } from "@/modules/flows";
import type { LeadMagnetSettings } from "@/modules/lead-magnets";
import { findSalesCliches } from "@/modules/program";
import { SILENCE_TILL_END, type CheckResult, type CheckStatus, type ClientRun, type ConsultantTurn, type FlowTransitionRecord, type ScenarioRun, type TimedBotMessage, type ToolCallRecord } from "./types";
import { personaChecks } from "./persona-checks";
import { standCheck } from "./verdict";

const SCENARIO = "сценарий";
const REQUIRED_TEXT_FIELDS = ["name", "cardDescription", "instruction", "firstMessage", "endCondition", "farewellMessage"] as const satisfies ReadonlyArray<keyof LeadMagnetSettings>;
/** Таблица, заголовок, жирный, длинный список (4+ пунктов) — в мессенджере это мусор (инструкции агентов). */
/** Имя, с которым лидмагнит создаётся в кабинете: если конструктор его не сменил, он не дописал настройки. */
const PLACEHOLDER_NAME = "Новый лидмагнит";
const MARKDOWN = [/^\s*\|.*\|\s*$/m, /^\s*#{1,6}\s/m, /\*\*[^*]+\*\*/, /^(?:\s*[-*•]\s.*\n){3}\s*[-*•]\s/m];

/** Конструктор говорит с экспертом в чате: ни списка из двух и больше пунктов (маркеры, нумерация), ни жирного, ни заголовков и таблиц. */
const CONSTRUCTOR_MARKUP = [/^\s*\|.*\|\s*$/m, /^\s*#{1,6}\s/m, /\*\*[^*]+\*\*|__[^_]+__/, /^\s*(?:[-*•]|\d+[.)])\s.*\n\s*(?:[-*•]|\d+[.)])\s/m];

/** Своё прощание консультанта при отказе или уходе — одна фраза. */
const OWN_FAREWELL_MAX_CHARS = 200;
/** Ответ на вопрос человека в поле `answer` у finish_dialog — коротко, до прощания из настроек. */
const AGREED_ANSWER_MAX_CHARS = 200;
/** Заглушка вместо ответа: «(пусто)», «(ответ оставлен пустым)», «[без ответа]» — модель описала молчание вместо того, чтобы промолчать. */
const PLACEHOLDER = /^\s*[(\[][^()[\]\n]*(?:пуст|без ответа|нет ответа|ответа нет|молч|ничего не (?:пиш|отвеч))[^()[\]\n]*[)\]]\s*$/im;
const SIGNED_UP = /запис(?:ал|ала|али|ываю|ала бы)\s+(?:вас|тебя)|вы записаны|ты записан/i;
const UNIT_LABEL: Record<string, string> = { s: "с", min: "мин", h: "ч", d: "дн." };
/** Судья переходов дешевле хода консультанта: не больше этой доли цены ходов (plan.md 6.2). */
const JUDGE_SHARE_MAX = 0.1;

const result = (id: string, title: string, subject: string, status: CheckStatus, details: string): CheckResult => ({ id, title, subject, status, details });
const verdict = (problems: string[]): CheckStatus => (problems.length ? "fail" : "pass");
const quote = (text: string, max = 120) => `«${text.length > max ? `${text.slice(0, max)}…` : text}»`;

/** Исход из итога прохождения, а если его нет — из вызова finish_dialog. */
export function outcomeOf(client: ClientRun): DialogOutcome | null {
  const fromCall = client.turns.flatMap((turn) => turn.tools).find((tool) => tool.name === "finish_dialog")?.input as { outcome?: unknown } | undefined;
  const outcome = client.passage?.summary?.outcome ?? fromCall?.outcome;
  return DIALOG_OUTCOMES.find((known) => known === outcome) ?? null;
}

export const clientSubject = (client: Pick<ClientRun, "index" | "name">) => `клиент ${client.index}: ${client.name}`;

function hasMarkdown(text: string): boolean {
  return MARKDOWN.some((pattern) => pattern.test(text));
}

function hasConstructorMarkup(text: string): boolean {
  return CONSTRUCTOR_MARKUP.some((pattern) => pattern.test(text));
}

/** Вызов упал или инструмент ответил `{ ok: false }`: оба — ошибка. */
function toolError(tool: ToolCallRecord): string | null {
  if (tool.error) return tool.error;
  const output = tool.output as { ok?: unknown; error?: unknown } | null | undefined;
  return output?.ok === false ? `ok:false${typeof output.error === "string" ? ` (${output.error})` : ""}` : null;
}

function errorsOf(run: ScenarioRun): string[] {
  const errors = [...run.runnerErrors, ...run.agentLogErrors];
  run.building.turns.forEach((turn, index) => {
    if (turn.status !== "complete") errors.push(`конструктор, ход ${index + 1}: статус ${turn.status}${turn.error ? ` (${turn.error})` : ""}`);
    for (const tool of turn.tools) {
      const error = toolError(tool);
      if (error) errors.push(`конструктор, ход ${index + 1}: ${tool.name} — ${error}`);
    }
  });
  if (run.building.error) errors.push(`конструктор: ${run.building.error}`);
  if (run.publishError) errors.push(`публикация: ${run.publishError}`);
  for (const client of run.clients) {
    const who = clientSubject(client);
    if (client.error) errors.push(`${who}: ${client.error}`);
    if (client.passage?.handoverReason) errors.push(`${who}: разговор передан эксперту — ${client.passage.handoverReason}`);
    client.turns.forEach((turn, index) => {
      for (const tool of turn.tools) {
        const error = toolError(tool);
        if (error) errors.push(`${who}, ход ${index + 1}: ${tool.name} — ${error}`);
      }
    });
  }
  return errors;
}

function settingsChecks(run: ScenarioRun): CheckResult[] {
  const saved = result("lead_magnet_saved", "Лидмагнит сохранён", SCENARIO, run.settings ? "pass" : "fail", run.settings ? "" : "черновика нет");
  if (!run.settings) return [saved, result("required_settings", "Обязательные настройки заполнены", SCENARIO, "skip", "черновика нет")];
  const settings = run.settings;
  const empty: string[] = REQUIRED_TEXT_FIELDS.filter((field) => !settings[field].trim());
  if (settings.name.trim() === PLACEHOLDER_NAME && !empty.includes("name")) empty.push("name");
  if (!Number.isInteger(settings.maxPersonMessages) || settings.maxPersonMessages < 1) empty.push("maxPersonMessages");
  // «Записал» без удачной правки в этом ходе: эксперт думает, что сохранено, а нет
  const falseSaves = run.building.turns.flatMap((turn, index) =>
    claimsSaved(turn.reply) && !turn.tools.some((tool) => tool.name === "edit_lead_magnet" && !tool.error && isSavedEdit(tool.output)) ? [`ход ${index + 1}: ${quote(turn.reply.replace(/\s+/g, " "))}`] : [],
  );
  const constructorMarkup = run.building.turns.flatMap((turn, index) => (hasConstructorMarkup(turn.reply) ? [`ход ${index + 1}: ${quote(turn.reply)}`] : []));
  return [
    saved,
    result("required_settings", "Обязательные настройки заполнены", SCENARIO, verdict(empty), empty.length ? `пусто: ${empty.join(", ")}` : ""),
    result("published", "Лидмагнит опубликован", SCENARIO, run.publishError ? "fail" : "pass", run.publishError ?? ""),
    result("constructor_save_claim", "Конструктор говорит «записал» только после удачной правки", SCENARIO, verdict(falseSaves), falseSaves.join("\n")),
    result("constructor_plain_text", "Конструктор пишет без списков, жирного, таблиц и заголовков", SCENARIO, verdict(constructorMarkup), constructorMarkup.join("\n")),
  ];
}

function finishReason(client: ClientRun, limit: number): string {
  switch (client.endedBy) {
    case "reply_limit":
      return `кончились реплики клиента (${client.clientReplies} реплик из ${limit})`;
    case "client_left":
      return "клиент попрощался, а консультант не вызвал finish_dialog";
    case "message_limit":
      return `приложение завершило прохождение по пределу сообщений человека (${client.passage?.personMessageCount ?? "?"})`;
    case "final_without_finish":
      return "сценарий перешёл в «Итог» мимо finish_dialog: нет итога и прощания";
    case "app_closed":
      return `приложение закрыло прохождение (${client.passage?.status ?? "?"}, конец сценария ${client.flow?.endReason ?? "?"})`;
    case "program_ended":
      return "вышел срок программы";
    case "error":
      return `разговор оборвался ошибкой: ${client.error ?? "без текста"}`;
    default:
      return "консультант не вызвал finish_dialog";
  }
}

/** Прощание по исходу: из настроек — только согласившемуся, иначе консультант прощается сам одной фразой. */
function farewellCheck(run: ScenarioRun, client: ClientRun, finishIndex: number): CheckResult {
  const check = (status: CheckStatus, details: string) => result("farewell", "Прощание по исходу", clientSubject(client), status, details);
  const farewell = run.settings?.farewellMessage.trim() ?? "";
  const sentFrom = (from: number) => Boolean(farewell) && client.turns.slice(from).some((turn) => turn.bot.join("\n").includes(farewell));

  if (finishIndex < 0) {
    if (client.endedBy !== "message_limit") return check("skip", "разговор не завершён");
    const last = client.turns.length - 1;
    return sentFrom(last) ? check("fail", `предел сообщений без finish_dialog, а ушло прощание из настроек ${quote(farewell)}`) : check("pass", "предел сообщений: прощания из настроек нет");
  }
  const outcome = outcomeOf(client);
  if (!outcome) return check("fail", "в finish_dialog нет исхода (outcome)");
  if (outcome === "agreed") {
    if (!farewell) return check("skip", "agreed, прощание в настройках не задано");
    return sentFrom(finishIndex) ? check("pass", "agreed, ушло прощание из настроек") : check("fail", `agreed, а нет текста ${quote(farewell)}`);
  }

  const own = client.turns[finishIndex]!.textAfterFinish?.trim() ?? "";
  const problems = [
    ...(sentFrom(finishIndex) ? [`ушло прощание из настроек ${quote(farewell)}`] : []),
    ...(!own ? ["консультант не попрощался сам"] : []),
    ...(own.length > OWN_FAREWELL_MAX_CHARS ? [`своё прощание длинное (${own.length} символов): ${quote(own)}`] : []),
    ...(SIGNED_UP.test(own) ? [`«записал вас» при исходе ${outcome}: ${quote(own)}`] : []),
  ];
  return check(verdict(problems), problems.length ? `${outcome}: ${problems.join("; ")}` : `${outcome}, своё прощание: ${quote(own)}`);
}

/** При согласии и заданном прощании человек получает только ответ из `answer` (если был вопрос), потом прощание из настроек. */
function agreedReplyCheck(run: ScenarioRun, client: ClientRun, finishIndex: number): CheckResult {
  const check = (status: CheckStatus, details: string) =>
    result("agreed_reply", "При согласии — только прощание и короткий ответ на вопрос", clientSubject(client), status, details);
  const farewell = run.settings?.farewellMessage.trim() ?? "";
  if (finishIndex < 0 || outcomeOf(client) !== "agreed") return check("skip", "исход не agreed");
  if (!farewell) return check("skip", "прощание в настройках не задано");

  const finishing = client.turns[finishIndex]!;
  const sent = finishing.bot.join("\n\n").trim();
  const at = sent.lastIndexOf(farewell);
  if (at < 0) return check("skip", "прощания из настроек нет — это провал проверки «Прощание по исходу»");
  const before = sent.slice(0, at).trim();
  const after = sent.slice(at + farewell.length).trim();
  // Отклонённый вызов (например, answer длиннее 200) не считается: берём итог или последний удачный вызов.
  const call = finishing.tools.filter((tool) => tool.name === "finish_dialog" && !tool.error).at(-1)?.input as { answer?: unknown } | undefined;
  const fromCall = typeof call?.answer === "string" ? call.answer : "";
  const answer = (client.passage?.summary?.answer ?? fromCall).trim();
  const sameText = (a: string, b: string) => a.replace(/\s+/g, " ") === b.replace(/\s+/g, " ");

  const problems = [
    ...(after ? [`после прощания ещё текст: ${quote(after)}`] : []),
    ...(before && !(answer && sameText(before, answer)) ? [`свой текст перед прощанием, не из answer: ${quote(before)}`] : []),
    ...(before && answer && sameText(before, answer) && answer.length > AGREED_ANSWER_MAX_CHARS ? [`ответ из answer длинный (${answer.length} символов): ${quote(answer)}`] : []),
  ];
  return check(verdict(problems), problems.length ? problems.join("; ") : before ? `ответ на вопрос: ${quote(before)}` : "только прощание из настроек");
}

/** Ссылка эксперта дошла до согласившегося дословно; ссылок не из настроек и не от клиента бот не давал. */
function linkChecks(run: ScenarioRun, client: ClientRun): CheckResult[] {
  const who = clientSubject(client);
  const link = run.scenario.expertLink;
  const sent = client.turns.flatMap((turn) => turn.bot);
  const delivered = !link
    ? result("expert_link_delivered", "Ссылка эксперта дошла до клиента дословно", who, "skip", "в сценарии нет ссылки")
    : sent.some((text) => text.includes(link))
      ? result("expert_link_delivered", "Ссылка эксперта дошла до клиента дословно", who, "pass", link)
      : outcomeOf(client) === "agreed"
        ? result("expert_link_delivered", "Ссылка эксперта дошла до клиента дословно", who, "fail", `согласился, а ссылки ${link} нет`)
        : result("expert_link_delivered", "Ссылка эксперта дошла до клиента дословно", who, "skip", "клиент не согласился");

  const settings = run.settings;
  // Результаты инструментов законны, как в бою (seenTexts SDK): ссылку с подставленным текстом собирает text_link
  const toolOutputs = client.turns.flatMap((turn) => turn.tools.map((tool) => JSON.stringify(tool.output ?? null)));
  const known = [...(settings ? leadMagnetKnownTexts(settings) : []), run.privacyPolicyUrl, ...client.turns.map((turn) => turn.client), ...toolOutputs];
  const invented = client.turns.flatMap((turn, index) => unknownLinksIn(turn.bot.join("\n"), known).map((found) => `ход ${index + 1}: ${found}`));
  return [delivered, result("no_invented_links", "Нет ссылок не из настроек", who, verdict(invented), invented.join("\n"))];
}

function clientChecks(run: ScenarioRun, client: ClientRun): CheckResult[] {
  const who = clientSubject(client);
  const flow = run.settings?.flow;
  const schedule = flow?.schedule ?? null;
  const finishIndex = client.turns.findIndex((turn) => turn.finished);
  const finished = finishIndex >= 0;
  const checks: CheckResult[] = [
    finished
      ? result("finish_dialog", "Консультант вызвал finish_dialog", who, "pass", `в ходе ${finishIndex + 1}`)
      : client.leftMidConversation
        ? result("finish_dialog", "Консультант вызвал finish_dialog", who, "skip", "клиент ушёл посреди разговора, не прощаясь и не отказываясь: завершать было нечего")
        : schedule
          ? // Программа кончается сроком: без «да» и «прекратите» завершать нечего
            result("finish_dialog", "Консультант вызвал finish_dialog", who, "skip", `программа без «да» и «прекратите»: ${finishReason(client, run.scenario.clientReplies)}`)
          : result("finish_dialog", "Консультант вызвал finish_dialog", who, "fail", finishReason(client, run.scenario.clientReplies)),
  ];

  const afterFinish: string[] = [];
  if (finished) {
    const finishing = client.turns[finishIndex]!;
    // При согласии с прощанием текст модели человеку не уходит — считаем только отправленное.
    const own = finishing.textAfterFinish?.trim() ?? "";
    const sentAfter = own !== "" && finishing.bot.join("\n\n").includes(own);
    if (sentAfter && own.includes("?")) afterFinish.push(`вопрос в последнем ответе: ${quote(own)}`);
    client.turns.slice(finishIndex + 1).forEach((turn, offset) => {
      if (turn.consultantMessages > 0) afterFinish.push(`после завершения, ход ${finishIndex + offset + 2}: ${quote(turn.bot.join(" / "))}`);
    });
  }
  checks.push(result("no_text_after_finish", "После finish_dialog нет вопросов и новых ответов", who, finished ? verdict(afterFinish) : "skip", afterFinish.join("\n")));

  // В программе молчание клиента и его сообщения с жёсткой рамки дня ответа не ждут: их проверяет program_hard_frame
  const hardAt = schedule?.dayFrame?.hardAt;
  const beyondFrame = hardAt ? turnsFromHardFrame(client, hardAt) : new Set<number>();
  const wrongCount = client.turns.flatMap((turn, index) =>
    turn.consultantMessages === 1 || (finished && index > finishIndex) || turn.silence !== undefined || beyondFrame.has(index)
      ? []
      : [`ход ${index + 1}: ответов ${turn.consultantMessages}`],
  );
  // Первый ход — приветствие приложения, не ответ консультанта
  const counted = wrongCount.filter((line) => !line.startsWith("ход 1:"));
  checks.push(result("one_message_per_turn", "Одно сообщение консультанта на ход", who, verdict(counted), counted.join("\n")));

  const first = client.turns[0]?.bot.join("\n") ?? "";
  checks.push(
    result("privacy_policy", "В первом сообщении ссылка на политику ПДн", who, first.includes(run.privacyPolicyUrl) ? "pass" : "fail", first ? quote(first, 200) : "первого сообщения нет"),
  );

  checks.push(farewellCheck(run, client, finishIndex));
  checks.push(agreedReplyCheck(run, client, finishIndex));

  const placeholders = client.turns.flatMap((turn, index) => turn.bot.filter((text) => PLACEHOLDER.test(text)).map((text) => `ход ${index + 1}: ${quote(text)}`));
  checks.push(result("no_placeholder", "Нет заглушек вроде «(пусто)» вместо ответа", who, verdict(placeholders), placeholders.join("\n")));

  const summary = client.passage?.summary;
  const missing = summary ? [...(["goal", "stuckAt", "chosenStep"] as const).filter((key) => !summary[key]?.trim()), ...(outcomeOf(client) ? [] : ["outcome"])] : [];
  checks.push(
    result("summary_complete", "Итог из трёх пунктов заполнен", who, !finished ? "skip" : !summary ? "fail" : verdict(missing), !summary ? "итога нет" : missing.length ? `пусто: ${missing.join(", ")}` : ""),
  );

  const videos = client.turns.flatMap((turn, index) => {
    const shown = turn.tools.filter((tool) => tool.name === "show_video").length;
    return shown > 1 ? [`ход ${index + 1}: роликов ${shown}`] : [];
  });
  checks.push(result("one_video_per_reply", "Не больше одного ролика за ответ", who, verdict(videos), videos.join("\n")));

  checks.push(...linkChecks(run, client));

  const markup = client.turns.flatMap((turn, index) => turn.bot.filter(hasMarkdown).map((text) => `ход ${index + 1}: ${quote(text)}`));
  checks.push(result("plain_text", "Сообщения клиенту без таблиц, заголовков и жирного", who, verdict(markup), markup.join("\n")));
  if (flow) checks.push(...flowChecks(flow, client));
  return checks;
}

/** Сообщения бота со временем по порядку; у хода — его номер. */
function botTimeline(client: ClientRun): Array<TimedBotMessage & { turn: number }> {
  return client.turns.flatMap((turn, index) => (turn.timeline ?? []).map((message) => ({ ...message, turn: index })));
}

const when = (message: { day?: number; localTime?: string; localDate?: string }) =>
  `${message.day !== undefined ? `день ${message.day}` : (message.localDate ?? "?")}, ${message.localTime ?? "?"}`;

/** Сообщения человека — то, что он написал сам: без /start и без молчания. */
const isPersonMessage = (turn: ConsultantTurn) => turn.silence === undefined && !turn.client.startsWith("/start");

/** Ходы с жёсткой рамки дня сценария: `hardAt`-е сообщение человека за день и дальше (`schedule.dayFrame`). */
function turnsFromHardFrame(client: ClientRun, hardAt: number): Set<number> {
  const perDay = new Map<number, number>();
  const beyond = new Set<number>();
  client.turns.forEach((turn, index) => {
    const day = turn.sentAt?.day;
    if (!isPersonMessage(turn) || day === undefined) return;
    const count = (perDay.get(day) ?? 0) + 1;
    perDay.set(day, count);
    if (count >= hardAt) beyond.add(index);
  });
  return beyond;
}

/** Правила сообщений первым, как их применяет сценарий: ночь и потолок — из «Дней и времени», иначе — приложения. */
function firstMessageRules(schedule: FlowSchedule | null) {
  return {
    nightFrom: schedule?.nightFrom ?? FIRST_MESSAGES_QUIET_HOURS.from,
    dayStart: schedule?.dayStart ?? FIRST_MESSAGES_QUIET_HOURS.to,
    maxPerDay: schedule?.firstMessages?.maxPerDay ?? FIRST_MESSAGES_PER_DAY,
  };
}

/** Проверки сценария: переходы, расход судьи, касания; у «Дней и времени» — правила программы. */
function flowChecks(flow: AgentFlow, client: ClientRun): CheckResult[] {
  const schedule = flow.schedule ?? null;
  const timeline = botTimeline(client);
  const outreach = timeline.filter((message) => message.kind === "outreach");
  const [nightId, perDayId] = schedule ? ["program_no_night_outreach", "program_outreach_per_day"] : ["nudges_no_night", "nudges_per_day"];
  const checks = [
    transitionReasonCheck(client),
    judgeShareCheck(client),
    abandonedCheck(flow, client),
    ...firstMessageChecks(client, outreach, firstMessageRules(schedule), nightId, perDayId),
  ];
  if (!schedule) return checks;
  return [...checks, saleNotEarlyCheck(flow, client), hardFrameCheck(client, schedule, timeline), salesClichesCheck(client, timeline), morningSingleCheck(client, schedule, outreach)];
}

/** Ночь — с `nightFrom` до `dayStart` по времени человека, как у SDK. Потолок — за дату человека. */
function firstMessageChecks(
  client: ClientRun,
  outreach: TimedBotMessage[],
  rules: ReturnType<typeof firstMessageRules>,
  nightId: string,
  perDayId: string,
): CheckResult[] {
  const who = clientSubject(client);
  const isNight = (time: string) => (rules.nightFrom > rules.dayStart ? time >= rules.nightFrom || time < rules.dayStart : time >= rules.nightFrom && time < rules.dayStart);
  const night = outreach.flatMap((message) => (message.localTime !== undefined && isNight(message.localTime) ? [`${when(message)}: ${quote(message.text)}`] : []));

  const perDay = new Map<string, number>();
  for (const message of outreach) {
    const key = message.day !== undefined ? `день ${message.day}` : message.localDate;
    if (key !== undefined) perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  const overLimit = [...perDay].flatMap(([day, count]) => (count > rules.maxPerDay ? [`${day}: ${count}`] : []));
  return [
    result(nightId, `Ночью бот не пишет первым: с ${rules.nightFrom} до ${rules.dayStart}`, who, verdict(night), night.length ? night.join("\n") : `сообщений первым: ${outreach.length}`),
    result(
      perDayId,
      `Не больше ${rules.maxPerDay} сообщений первым в день`,
      who,
      verdict(overLimit),
      overLimit.length ? `сверх потолка — ${overLimit.join("; ")}` : [...perDay].map(([day, count]) => `${day}: ${count}`).join("; "),
    ),
  ];
}

const nodeTitle = (title: string | null) => (title ? `«${title}»` : "начало");

/** У каждого перехода сценария есть причина словами: её видят «Лог», судья eval и эксперт (plan.md 6.2). */
function transitionReasonCheck(client: ClientRun): CheckResult {
  const check = (status: CheckStatus, details: string) => result("flow_transition_reason", "У каждого перехода сценария есть причина", clientSubject(client), status, details);
  if (!client.flow) return check("skip", "пути по сценарию нет");
  const titles = new Map(client.flow.transitions.map((step) => [step.to, step.title]));
  const moves = client.flow.transitions.filter((step) => step.decidedBy !== "start" && step.decidedBy !== "migrate");
  const describe = (step: FlowTransitionRecord) => `${nodeTitle(step.from && (titles.get(step.from) ?? step.from))} → «${step.title}» (${step.decidedBy}, день ${step.day ?? "—"})`;
  const silent = moves.filter((step) => !step.reason?.trim());
  if (silent.length) return check("fail", silent.map((step) => `без причины: ${describe(step)}`).join("\n"));
  return check("pass", moves.length ? moves.map((step) => `${describe(step)}: ${quote(step.reason!.trim())}`).join("\n") : "переходов не было");
}

const percent = (share: number) => `${Math.round(share * 100)} %`;

/** Судья переходов стоит не больше 10 % цены ходов консультанта этого разговора (plan.md 6.2). */
function judgeShareCheck(client: ClientRun): CheckResult {
  const check = (status: CheckStatus, details: string) => result("flow_judge_share", `Судья — не больше ${percent(JUDGE_SHARE_MAX)} цены ходов`, clientSubject(client), status, details);
  if (!client.usage) return check("skip", "расхода разговора нет");
  const { answerUsd, firstMessageUsd, correctionUsd, judgeUsd } = client.usage;
  const turnsUsd = answerUsd + firstMessageUsd + correctionUsd;
  if (turnsUsd <= 0) return check("skip", "ходы консультанта бесплатны или их не было");
  const share = judgeUsd / turnsUsd;
  return check(share <= JUDGE_SHARE_MAX ? "pass" : "fail", `судья $${judgeUsd.toFixed(5)} из $${turnsUsd.toFixed(5)} за ходы — ${percent(share)}`);
}

/** Клиент замолчал посреди разговора: бот касается его, а через `giveUpAfter` тишины разговор — «не завершил». */
function abandonedCheck(flow: AgentFlow, client: ClientRun): CheckResult {
  const check = (status: CheckStatus, details: string) => result("flow_abandoned", "Молчание после разговора: касания, потом «не завершил»", clientSubject(client), status, details);
  const giveUp = (flow.schedule?.nudges ?? flow.nudges)?.giveUpAfter;
  if (!giveUp) return check("skip", "у сценария нет «не завершил» по тишине");
  const tail = client.turns.findIndex((turn) => turn.silence === SILENCE_TILL_END);
  if (tail < 0) return check("skip", `клиент не молчал до конца разговора: ${client.endedBy}`);

  const touches = (client.turns[tail]!.timeline ?? []).filter((message) => message.kind === "outreach");
  const listed = touches.map((message) => when(message)).join("; ");
  const ended = client.passage?.status === "not_completed" && client.flow?.endReason === "abandoned";
  const problems = [
    ...(ended ? [] : [`разговор не закончился «не завершил»: прохождение ${client.passage?.status ?? "нет"}, конец сценария ${client.flow?.endReason ?? "нет"}`]),
    ...(touches.length ? [] : ["касаний не было"]),
  ];
  const summary = `тишина до «не завершил» — ${giveUp.amount} ${UNIT_LABEL[giveUp.unit] ?? giveUp.unit}; касаний: ${touches.length}${listed ? ` (${listed})` : ""}`;
  return check(verdict(problems), problems.length ? `${problems.join("; ")}. ${summary}` : summary);
}

/** День «Продажи» по сроку нод: от старта по выходам «нода длится N дней» до ноды с меткой «продажа». */
function plannedSaleDay(flow: AgentFlow): { title: string; id: string; day: number } | null {
  const isSale = (id: string) => flow.states.find((state) => state.id === id)?.tags.includes(SALE_TAG) ?? false;
  if (flow.start === null) return null;
  let current: string = flow.start;
  let day = 1;
  const seen = new Set<string>();
  while (!isSale(current)) {
    if (seen.has(current)) return null;
    seen.add(current);
    const exits = flow.states.find((state) => state.id === current)?.exits ?? [];
    // Срок в «Продажу» — таймер «день N программы», в остальные ноды — «нода длится N дней»
    const programDay = exits.flatMap((exit) =>
      exit.when.type === "timer" && exit.when.from === "program_day" && exit.to && isSale(exit.to) ? [{ day: exit.when.day, to: exit.to }] : [],
    )[0];
    if (programDay) {
      day = programDay.day;
      current = programDay.to;
      continue;
    }
    const exit = exits.find((candidate) => candidate.when.type === "timer" && candidate.when.from === "state_days");
    if (!exit?.to || exit.when.type !== "timer" || exit.when.from !== "state_days") return null;
    day += exit.when.days;
    current = exit.to;
  }
  const sale = flow.states.find((state) => state.id === current)!;
  return { id: sale.id, title: sale.title, day };
}

/** «Продажа» раньше своего дня — только заявкой агента или судьёй, с причиной. */
function saleNotEarlyCheck(flow: AgentFlow, client: ClientRun): CheckResult {
  const sale = plannedSaleDay(flow);
  const title = `«Продажа» не раньше своего дня${sale ? ` (день ${sale.day})` : ""} без причины`;
  const check = (status: CheckStatus, details: string) => result("program_sale_not_early", title, clientSubject(client), status, details);
  if (!sale) return check("skip", "у сценария нет ноды с меткой «продажа», в которую ведут сроки нод");
  const entries = (client.flow?.transitions ?? []).filter((step) => step.to === sale.id);
  if (entries.length === 0) return check("pass", `до «${sale.title}» не дошли`);

  const problems = entries
    .filter((step) => step.day !== null && step.day < sale.day)
    .flatMap((step) =>
      step.decidedBy === "timer" || step.decidedBy === "event"
        ? [`день ${step.day}: «${sale.title}» включилась по сроку, а её день — ${sale.day}`]
        : !step.reason?.trim()
          ? [`день ${step.day}: «${sale.title}» раньше дня ${sale.day} без причины (${step.decidedBy})`]
          : [],
    );
  const described = entries.map((step) => `день ${step.day ?? "?"}, ${step.decidedBy}${step.reason?.trim() ? `: ${quote(step.reason.trim())}` : ""}`);
  return check(verdict(problems), problems.length ? problems.join("\n") : described.join("\n"));
}

/**
 * Жёсткая рамка дня (`schedule.dayFrame`): на `hardAt`-е сообщение за день — фраза рамки один раз, на остальные —
 * тишина, и до конца этого дня сценария ни ответов консультанта, ни сообщений первым.
 */
function hardFrameCheck(client: ClientRun, schedule: FlowSchedule, timeline: Array<TimedBotMessage & { turn: number }>): CheckResult {
  const hardAt = schedule.dayFrame?.hardAt;
  const check = (status: CheckStatus, details: string) =>
    result("program_hard_frame", `С жёсткой рамки (${hardAt ?? "—"}-е сообщение за день) — одна фраза и тишина до утра`, clientSubject(client), status, details);
  if (!hardAt) return check("skip", "у сценария нет жёсткой рамки дня");
  const beyond = [...turnsFromHardFrame(client, hardAt)];
  if (beyond.length === 0) return check("skip", "рамку дня не прошли");

  const problems: string[] = [];
  const closedDays = [...new Set(beyond.map((index) => client.turns[index]!.sentAt!.day!))];
  for (const day of closedDays) {
    const firstBeyond = beyond.find((index) => client.turns[index]!.sentAt!.day === day)!;
    const after = timeline.filter((message) => message.turn >= firstBeyond && message.day === day);
    const stubs = after.filter((message) => message.kind === "day_closed");
    if (stubs.length === 0) problems.push(`день ${day}: на ${hardAt}-е сообщение не ушла фраза рамки`);
    if (stubs.length > 1) problems.push(`день ${day}: фраз рамки ${stubs.length}, а должна быть одна`);
    for (const message of after.filter((one) => one.kind === "consultant" || one.kind === "outreach"))
      problems.push(`${when(message)}: ${message.kind === "outreach" ? "сообщение первым" : "ответ консультанта"} после рамки ${quote(message.text)}`);
  }
  return check(verdict(problems), problems.length ? problems.join("\n") : `рамка пройдена в дни: ${closedDays.join(", ")}; одна фраза, дальше тишина`);
}

/** Заученные фразы, нажим и фальшивая срочность в ответах и сообщениях первым. */
function salesClichesCheck(client: ClientRun, timeline: TimedBotMessage[]): CheckResult {
  const found = timeline.flatMap((message) => {
    const cliches = findSalesCliches(message.text);
    return cliches.length ? [`${when(message)}: ${cliches.map((phrase) => `«${phrase}»`).join(", ")} в ${quote(message.text)}`] : [];
  });
  return result("program_no_sales_cliches", "Нет штампов продаж", clientSubject(client), verdict(found), found.join("\n"));
}

/** В начале дня все причины написать — одно сообщение: переход по сроку, утреннее, ответ на ночное (plan.md 6.2). */
function morningSingleCheck(client: ClientRun, schedule: FlowSchedule, outreach: TimedBotMessage[]): CheckResult {
  const perMorning = new Map<number, TimedBotMessage[]>();
  for (const message of outreach)
    if (message.day !== undefined && message.localTime === schedule.dayStart) perMorning.set(message.day, [...(perMorning.get(message.day) ?? []), message]);
  const extra = [...perMorning].flatMap(([day, messages]) => (messages.length > 1 ? [`день ${day}: ${messages.length} сообщения в ${schedule.dayStart} — ${messages.map((message) => quote(message.text, 60)).join(" / ")}`] : []));
  const details = extra.length ? extra.join("\n") : perMorning.size ? `утренние в дни: ${[...perMorning.keys()].join(", ")}` : "утренних сообщений не было";
  return result("flow_morning_single", `Утром одно сообщение на все причины (${schedule.dayStart})`, clientSubject(client), verdict(extra), details);
}

/** Сбой провайдера, который закрыл запасной путь, — не упавший вызов: виден в подробностях, проверку не валит. */
function noErrorsCheck(errors: string[], recovered: string[]): CheckResult {
  const note = recovered.length ? [`сбоев провайдера, которые закрыл запасной путь: ${recovered.length}`, ...recovered] : [];
  return result("no_errors", "Нет ошибок и упавших вызовов", SCENARIO, verdict(errors), [...errors, ...note].join("\n"));
}

export function checkScenario(run: ScenarioRun): CheckResult[] {
  const errors = errorsOf(run);
  return [
    standCheck(run),
    ...settingsChecks(run),
    noErrorsCheck(errors, run.agentLogRecovered ?? []),
    ...run.clients.flatMap((client) => clientChecks(run, client)),
    ...personaChecks(run),
  ];
}
