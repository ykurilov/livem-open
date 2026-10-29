// Markdown для судьи и человека: переписки, настройки, проверки. Чистые функции.
import type { FlowCondition, FlowState } from "@ykurilov/agent-chat-flows/format";
import type { DialogOutcome } from "@/modules/consultant/schema";
import type { LeadMagnetSettings } from "@/modules/lead-magnets";
import { outcomeOf } from "./checks";
import type { BotMessageKind, CheckResult, ClientRun, ConsultantTurn, EventMoment, ScenarioRun, ToolCallRecord, UsageTotals } from "./types";

/** 🎭 — сбой персонажа, 🧱 — сломан стенд: прогон не годится для оценки агента, это не его провал. */
export const STATUS_MARK = { pass: "✅", fail: "❌", skip: "➖", persona_broke: "🎭", stand_broke: "🧱" } as const;

const json = (value: unknown) => JSON.stringify(value, null, 2);
const quoteBlock = (text: string) => (text.trim() ? text.trim().split("\n").map((line) => `> ${line}`).join("\n") : "> _(пусто)_");
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} с`;

function renderTools(tools: ToolCallRecord[]): string {
  return tools
    .map((tool) => {
      const lines = [`- 🔧 \`${tool.name}\``, "", "  ```json", ...json(tool.input).split("\n").map((line) => `  ${line}`), "  ```"];
      if (tool.error) lines.push(`  ⚠️ Ошибка: ${tool.error}`);
      else if (tool.output !== undefined) lines.push("  Результат:", "", "  ```json", ...json(tool.output).split("\n").map((line) => `  ${line}`), "  ```");
      return lines.join("\n");
    })
    .join("\n");
}

export function renderConstructor(run: ScenarioRun): string {
  const { building } = run;
  if (building.endedBy === "from_file")
    return `# Конструктор — ${run.scenario.title} (\`${run.scenario.id}\`)\n\nНе участвовал: лидмагнит взят из файла \`${run.scenario.leadMagnet?.file ?? "?"}\` с правкой из сценария.\n`;
  const header = [
    `# Конструктор — ${run.scenario.title} (\`${run.scenario.id}\`)`,
    "",
    `Реплик эксперта: ${building.expertReplies} из ${run.scenario.expertReplies ?? "?"}. Конец: ${building.endedBy}.`,
    building.error ? `\n⚠️ ${building.error}` : "",
  ];
  const turns = building.turns.map((turn, index) =>
    [
      `## Ход ${index + 1} (${seconds(turn.durationMs)}, статус ${turn.status}${turn.error ? `, ошибка ${turn.error}` : ""})`,
      "",
      "**Эксперт:**",
      "",
      quoteBlock(turn.expert),
      "",
      turn.tools.length ? `**Инструменты конструктора:**\n\n${renderTools(turn.tools)}\n` : "",
      "**Конструктор:**",
      "",
      quoteBlock(turn.reply),
    ].join("\n"),
  );
  return [...header, "", ...turns].join("\n") + "\n";
}

const UNIT_LABEL: Record<string, string> = { s: "с", min: "мин", h: "ч", d: "дн." };

/** Условие выхода словами для человека. */
function conditionText(when: FlowCondition): string {
  switch (when.type) {
    case "judge":
      return `словами: «${when.text}»`;
    case "event":
      return when.event === "tool" && "name" in when ? `инструмент ${when.name}` : `событие ${when.event}`;
    case "data":
      return "по данным карточки";
    case "timer":
      if (when.from === "state_days") return `через ${when.days} дн.`;
      if (when.from === "time_of_day") return `в ${when.at}`;
      if (when.from === "program_day") return `с дня ${when.day} программы`;
      return `таймер ${when.from} ${when.amount} ${UNIT_LABEL[when.unit] ?? when.unit}`;
  }
}

function renderState(state: FlowState, titleOf: (id: string) => string): string {
  const exits = state.exits.map((exit) => `- ${conditionText(exit.when)} → ${exit.to === null ? "_(цель не выбрана)_" : `«${titleOf(exit.to)}»`}`);
  return [`### ${state.title}${state.tags.length ? ` (метки: ${state.tags.join(", ")})` : ""}`, "", state.instructions.trim() || "_(без инструкции)_", "", ...(exits.length ? exits : ["_(конечная)_"]), ""].join("\n");
}

export function renderLeadMagnet(settings: LeadMagnetSettings | null, publishError: string | null): string {
  if (!settings) return "# Лидмагнит\n\nЧерновик не сохранился.\n";
  const field = (title: string, value: string) => `## ${title}\n\n${value.trim() || "_(пусто)_"}\n`;
  const { flow } = settings;
  const titleOf = (id: string) => flow.states.find((state) => state.id === id)?.title ?? id;
  const schedule = flow.schedule;
  const nudges = schedule?.nudges ?? flow.nudges;
  const scheduleLine = schedule
    ? `Дни и время: ${schedule.lengthDays ?? "?"} дн., день с ${schedule.dayStart}, ночь с ${schedule.nightFrom ?? "—"}; рамки дня ${schedule.dayFrame?.softFrom ?? "—"}/${schedule.dayFrame?.hardAt ?? "—"} сообщений; ` +
      `не больше ${schedule.firstMessages?.maxPerDay ?? "—"} сообщений первым в день; по сроку — «${titleOf(schedule.deadlineState ?? "")}».`
    : "";
  const nudgesLine = nudges
    ? `Касания: через ${nudges.afterSilence?.map((span) => `${span.amount} ${UNIT_LABEL[span.unit] ?? span.unit}`).join(", ") || "—"} тишины${nudges.dailyAt?.length ? `, потом в ${nudges.dailyAt.join(" и ")}` : ""}` +
      `${nudges.giveUpAfter ? `; «не завершил» — через ${nudges.giveUpAfter.amount} ${UNIT_LABEL[nudges.giveUpAfter.unit] ?? nudges.giveUpAfter.unit} тишины` : ""}.`
    : "";
  const states = flow.states.map((state) => renderState(state, titleOf)).join("\n");
  return [
    `# Лидмагнит «${settings.name}»`,
    "",
    publishError ? `⚠️ Не опубликован: ${publishError}\n` : "",
    `Модель: ${settings.providerId}/${settings.modelId}, рассуждение: ${settings.reasoning ?? "по умолчанию"}. Предел сообщений человека: ${settings.maxPersonMessages}.`,
    `Поля карточки: ${flow.clientCard.length}, ролики: ${settings.videoIds.length}.`,
    scheduleLine,
    nudgesLine,
    "",
    field("Описание", settings.cardDescription),
    field("Инструкция (общее для всех нод)", flow.common),
    field("Первое сообщение", settings.firstMessage),
    `## Сценарий (старт — «${flow.start ? titleOf(flow.start) : "?"}»)\n\n${states}`,
    field("Условие завершения", settings.endCondition),
    field("Прощание", settings.farewellMessage),
  ].join("\n");
}

const OUTCOME_LABEL: Record<DialogOutcome, string> = { agreed: "согласился", declined: "отказался", left: "ушёл" };
const BOT_KIND_LABEL: Record<BotMessageKind, string> = { consultant: "", outreach: ", пишет первым", day_closed: ", фраза рамки дня", other: ", служебное" };
const DECIDED_BY_LABEL: Record<string, string> = { start: "начало", claim: "заявка консультанта", judge: "судья", data: "по данным", event: "событие", timer: "по сроку", migrate: "перевод" };

/** Когда: день сценария (если есть) и время у человека. */
const momentLabel = (moment: EventMoment) => [moment.day !== undefined ? `день ${moment.day}` : "", moment.localTime ?? ""].filter(Boolean).join(", ");

/** Сообщения бота за ход — со временем у человека и видом. */
function renderBot(turn: ConsultantTurn): string[] {
  if (turn.timeline)
    return turn.timeline.flatMap((message) => [`**Бот (${momentLabel(message) || "?"}${BOT_KIND_LABEL[message.kind]}):**`, "", quoteBlock(message.text), ""]);
  return turn.bot.flatMap((text, number) => [`**Бот${turn.bot.length > 1 ? `, сообщение ${number + 1}` : ""}:**`, "", quoteBlock(text), ""]);
}

function renderClientLine(turn: ConsultantTurn): string[] {
  const at = turn.sentAt ? momentLabel(turn.sentAt) : "";
  if (turn.silence !== undefined) return [`**Клиент молчит ${turn.silence}** — до ${at || "?"}.`, ""];
  return [`**Клиент${at ? ` (${at})` : ""}:**`, "", quoteBlock(turn.client), ""];
}

export function renderClient(run: ScenarioRun, client: ClientRun): string {
  const passage = client.passage;
  const outcome = outcomeOf(client);
  const header = [
    `# Клиент ${client.index}: ${client.name} — ${run.scenario.title}`,
    "",
    `Реплик клиента: ${client.clientReplies} из ${run.scenario.clientReplies}. Конец: ${client.endedBy}${client.leftMidConversation ? " (посреди разговора, не прощаясь)" : ""}.`,
    passage
      ? `Прохождение: ${passage.status}, сообщений человека ${passage.personMessageCount}.${passage.handoverReason ? ` Передано эксперту: ${passage.handoverReason}.` : ""}`
      : "Прохождения нет.",
    outcome ? `Исход: ${outcome} — ${OUTCOME_LABEL[outcome]}.` : client.turns.some((turn) => turn.finished) ? "Исход: не указан." : "",
    passage?.summary ? `Итог: цель — ${passage.summary.goal}; застрял — ${passage.summary.stuckAt}; шаг — ${passage.summary.chosenStep}.` : "",
    client.flow?.transitions.length
      ? `Сценарий: ${client.flow.transitions
          .map((step) => `${step.day !== null ? `день ${step.day} ` : ""}→ «${step.title}», ${DECIDED_BY_LABEL[step.decidedBy] ?? step.decidedBy}${step.reason ? `: ${step.reason}` : ""}`)
          .join("; ")}. Конец по сценарию: ${client.flow.endReason ?? "не наступил"}.`
      : "",
    client.usage
      ? `Расход разговора: ответы $${client.usage.answerUsd.toFixed(4)}, касания $${client.usage.firstMessageUsd.toFixed(4)}, переписка ответа $${client.usage.correctionUsd.toFixed(4)}, судья $${client.usage.judgeUsd.toFixed(4)}.`
      : "",
    client.error ? `\n⚠️ ${client.error}` : "",
  ];
  const turns = client.turns.map((turn, index) =>
    [
      `## Ход ${index + 1} (${seconds(turn.durationMs)}, ответов консультанта: ${turn.consultantMessages}${turn.finished ? ", finish_dialog" : ""})`,
      "",
      ...renderClientLine(turn),
      turn.tools.length ? `**Инструменты консультанта:**\n\n${renderTools(turn.tools)}\n` : "",
      ...renderBot(turn),
    ].join("\n"),
  );
  return [...header, "", ...turns].join("\n") + "\n";
}

export function renderChecks(run: ScenarioRun, checks: CheckResult[], stats: ScenarioStats): string {
  const rows = checks.map(
    (check) => `| ${STATUS_MARK[check.status]} | ${check.title} | ${check.subject} | ${check.details.replace(/\n/g, "<br>").replace(/\|/g, "\\|")} |`,
  );
  return [
    `# Проверки кодом — ${run.scenario.title} (\`${run.scenario.id}\`, ${run.scenario.kind})`,
    "",
    "| | Проверка | Кто | Подробности |",
    "|---|---|---|---|",
    ...rows,
    "",
    "## Цифры",
    "",
    `- Время сценария: ${seconds(stats.durationMs)}`,
    `- Реплик эксперта: ${stats.expertReplies}; реплик клиентов: ${stats.clientReplies.join(", ")}`,
    `- Токены наших агентов: вход ${stats.agents.inputTokens} (из кэша ${stats.agents.cachedInputTokens}), выход ${stats.agents.outputTokens}`,
    `- Токены персонажей: вход ${stats.personas.inputTokens}, выход ${stats.personas.outputTokens}`,
    ...(run.personaRoute
      ? [
          `- Персонажи: ${run.personaRoute.model} у ${run.personaRoute.provider}, температура ${run.personaRoute.temperature}; запросов ${run.personaRoute.requests}, ответили: ${
            Object.entries(run.personaRoute.served).map(([name, count]) => `${name} ${count}`).join(", ") || "—"
          }${run.personaRoute.failed ? `; ответов с ошибкой (повторены): ${run.personaRoute.failed}` : ""}`,
        ]
      : []),
    `- Стоимость: $${stats.costUsd.toFixed(4)} (агенты $${stats.agents.costUsd.toFixed(4)}, персонажи $${stats.personas.costUsd.toFixed(4)})`,
    ...(stats.bySource
      ? [
          `  - Судья переходов: $${stats.bySource.judge.costUsd.toFixed(4)}`,
          `  - Касания (агент пишет первым): $${stats.bySource.firstMessage.costUsd.toFixed(4)}`,
          `  - Переписка ответа: $${stats.bySource.answerCorrection.costUsd.toFixed(4)}`,
        ]
      : []),
    "",
  ].join("\n");
}

export interface ScenarioStats {
  durationMs: number;
  expertReplies: number;
  clientReplies: number[];
  agents: UsageTotals;
  personas: UsageTotals;
  /** Часть расхода агентов: судья, касания, переписка ответа. */
  bySource?: ScenarioRun["usage"]["bySource"];
  costUsd: number;
}

export function statsOf(run: ScenarioRun): ScenarioStats {
  return {
    durationMs: run.durationMs,
    expertReplies: run.building.expertReplies,
    clientReplies: run.clients.map((client) => client.clientReplies),
    agents: run.usage.agents,
    personas: run.usage.personas,
    ...(run.usage.bySource && { bySource: run.usage.bySource }),
    costUsd: run.usage.agents.costUsd + run.usage.personas.costUsd,
  };
}
