// Разговор клиента с ботом: /start, потом реплики, пока консультант не завершит, клиент не уйдёт или не кончатся реплики.
// Разговор не кончился — клиент молчит дальше, пока он не кончится сам: касания бота, «не завершил» или «срок вышел».
import type { ClientLine } from "./app-under-test";
import { incomingForClient } from "./persona-prompts";
import type { Persona } from "./persona";
import type { ClientRun } from "./types";

/** Молчаний клиента за день программы — с запасом: утро, день, вечер, ночь. */
const SILENCES_PER_DAY = 4;

/** Прохождение закрыло приложение, а не консультант: по концу сценария — предел сообщений, «Итог» мимо finish_dialog или иначе. */
function closedBy(endReason: string | null): ClientRun["endedBy"] {
  if (endReason === "message_limit") return "message_limit";
  return endReason === "final" ? "final_without_finish" : "app_closed";
}

export async function runClientSession(input: {
  line: ClientLine;
  client: Persona;
  startCode: string;
  replyLimit: number;
  index: number;
  name: string;
  /** Программа на столько дней: столько раз по четыре молчания клиенту хватит с запасом. */
  days?: number;
}): Promise<ClientRun> {
  const { line, client } = input;
  const silenceLimit = Math.max(input.days ?? 0, 2) * SILENCES_PER_DAY;
  let silences = 0;
  const run: ClientRun = { index: input.index, name: input.name, turns: [], clientReplies: 0, endedBy: "reply_limit", passage: null, chat: [] };
  const ended = async (): Promise<boolean> => {
    if (run.turns.at(-1)?.finished) {
      run.endedBy = "consultant_finished";
      return true;
    }
    const passage = await line.passage();
    if (passage && passage.status !== "active") {
      run.endedBy = passage.status === "term_ended" ? "program_ended" : closedBy((await line.flowRun())?.endReason ?? null);
      return true;
    }
    return false;
  };

  try {
    run.turns.push(await line.send(`/start ${input.startCode}`, { startCode: input.startCode }));
    while (!(await ended()) && run.clientReplies < input.replyLimit && silences < silenceLimit) {
      const said = await client.reply(incomingForClient(run.turns.at(-1)!));
      for (const slip of said.slips ?? []) (run.personaSlips ??= []).push(`реплика ${run.clientReplies + 1}: ${slip}`);
      if (said.text) {
        run.clientReplies += 1;
        run.turns.push(await line.send(said.text));
      }
      // Молчание клиента программы: часы стенда идут вперёд, бот может написать первым
      if (said.silence !== undefined && !said.finished && !(await ended())) {
        silences += 1;
        run.turns.push(await line.wait(said.silence));
        continue;
      }
      if (said.finished) {
        if (!(await ended())) {
          run.endedBy = "client_left";
          // Без прощания боту нечего было завершать. Отметки нет — судим по тому, ушёл ли клиент молча.
          if (said.saidGoodbye === false || (said.saidGoodbye === undefined && !said.text)) run.leftMidConversation = true;
        }
        break;
      }
    }
    // Разговор идёт, а клиент больше не пишет: молчит, пока разговор не кончится сам
    if (!run.turns.at(-1)?.finished && (await line.passage())?.status === "active") {
      run.turns.push(await line.waitTillEnd());
      if ((await line.passage())?.status === "term_ended") run.endedBy = "program_ended";
    }
  } catch (error) {
    run.endedBy = "error";
    run.error = error instanceof Error ? error.message : String(error);
  }
  run.passage = await line.passage();
  run.chat = await line.chat();
  const shortLinks = await line.shortLinks();
  if (shortLinks.length > 0) run.shortLinks = shortLinks;
  const flow = await line.flowRun();
  if (flow) run.flow = flow;
  const usage = await line.usage();
  if (usage) run.usage = usage;
  return run;
}
