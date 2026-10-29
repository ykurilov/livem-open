// Сборка лидмагнита: эксперт говорит с конструктором, пока не закончит сам или не кончатся реплики.
import type { AppUnderTest } from "./app-under-test";
import { EXPERT_KICKOFF } from "./persona-prompts";
import type { Persona } from "./persona";
import type { ScenarioRun } from "./types";

export async function runExpertSession(app: AppUnderTest, expert: Persona, replyLimit: number): Promise<ScenarioRun["building"]> {
  const building: ScenarioRun["building"] = { turns: [], expertReplies: 0, endedBy: "reply_limit", chat: [] };
  try {
    let incoming = EXPERT_KICKOFF;
    while (building.expertReplies < replyLimit) {
      const said = await expert.reply(incoming);
      for (const slip of said.slips ?? []) (building.personaSlips ??= []).push(`реплика ${building.expertReplies + 1}: ${slip}`);
      if (said.text) {
        building.expertReplies += 1;
        const turn = await app.askConstructor(said.text);
        building.turns.push(turn);
        incoming = turn.reply || "[Конструктор ничего не ответил]";
      }
      if (said.finished) {
        building.endedBy = "expert_finished";
        break;
      }
    }
  } catch (error) {
    building.endedBy = "error";
    building.error = error instanceof Error ? error.message : String(error);
  }
  building.chat = await app.constructorChat();
  return building;
}
