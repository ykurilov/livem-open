// Один сценарий целиком: своя база → эксперт собирает лидмагнит → публикация → клиенты параллельно → расход.
import { randomUUID } from "node:crypto";
import type { ModelChoice } from "@ykurilov/agent-chat-core";
import type { AppModels } from "@/modules/platform/app-models";
import type { Database } from "@/modules/platform/db";
import { startAppUnderTest, type AppUnderTest } from "./app-under-test";
import { runClientSession } from "./client-session";
import { createEvalDatabase } from "./eval-database";
import { runExpertSession } from "./expert-session";
import { createPersona, type Persona } from "./persona";
import type { PersonaRoute } from "./persona-model";
import { CLIENT_LEAVE_TOOL, clientInstructions, EXPERT_FINISH_TOOL, expertInstructions } from "./persona-prompts";
import { leadMagnetInput, type Scenario } from "./scenario";
import type { ClientRun, ScenarioRun } from "./types";
import { NO_USAGE, totalUsage } from "./usage";

/** Ссылка на политику ПДн, которую прогон пишет в настройки приложения. */
export const EVAL_PRIVACY_POLICY_URL = "https://eval.local/privacy";

export interface ScenarioDatabase {
  db: Database;
  url: string;
  drop(): Promise<void>;
}

export interface RunScenarioOptions {
  models: AppModels;
  /** Маршрут персонажей на этот прогон сценария: своя модель, поставщик и учёт, кто ответил. */
  openPersonaRoute(): PersonaRoute;
  privacyPolicyUrl: string;
  createDatabase?: (label: string) => Promise<ScenarioDatabase>;
  /** Откуда читать файл лидмагнита сценария; по умолчанию — текущая папка. */
  projectRoot?: string;
  /** Запасной судья сценария; нет — как в приложении. */
  judgeFallback?: ModelChoice;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runScenario(scenario: Scenario, options: RunScenarioOptions): Promise<ScenarioRun> {
  const startedAt = new Date();
  const run: ScenarioRun = {
    scenario,
    startedAt: startedAt.toISOString(),
    durationMs: 0,
    building: { turns: [], expertReplies: 0, endedBy: "error", chat: [] },
    settings: null,
    publishError: null,
    privacyPolicyUrl: options.privacyPolicyUrl,
    clients: [],
    agentLogErrors: [],
    runnerErrors: [],
    usage: { agents: NO_USAGE, personas: NO_USAGE },
  };
  const personas: Persona[] = [];
  const personaRoute = options.openPersonaRoute();
  const persona = async (instructions: string, exitTool: string, exitDescription: string, askGoodbye = false, silenceTools = false) => {
    const created = await createPersona({ model: personaRoute, instructions, exitTool, exitDescription, askGoodbye, silenceTools });
    personas.push(created);
    return created;
  };

  const database = await (options.createDatabase ?? createEvalDatabase)(scenario.id);
  let app: AppUnderTest | undefined;
  try {
    app = await startAppUnderTest({
      db: database.db,
      databaseUrl: database.url,
      models: options.models,
      privacyPolicyUrl: options.privacyPolicyUrl,
      ...(options.judgeFallback && { judgeFallback: options.judgeFallback }),
    });
    if (scenario.leadMagnet) {
      // Лидмагнит готов заранее: конструктор не участвует, сразу клиенты
      run.building = { ...run.building, endedBy: "from_file" };
      run.settings = await app.useLeadMagnet(await leadMagnetInput(scenario, options.projectRoot ?? process.cwd()));
    } else {
      const expert = await persona(expertInstructions(scenario), EXPERT_FINISH_TOOL, "Закончить сборку лидмагнита");
      run.building = await runExpertSession(app, expert, scenario.expertReplies ?? 0);
      run.settings = await app.draft();
    }

    let code: string | null = null;
    try {
      code = await app.publish();
    } catch (error) {
      run.publishError = message(error);
    }

    if (code) {
      const startCode = code;
      const currentApp = app;
      run.clients = await Promise.all(
        scenario.clients.map(async (card, index): Promise<ClientRun> => {
          const base = { index: index + 1, name: card.name };
          try {
            const client = await persona(clientInstructions(scenario, card), CLIENT_LEAVE_TOOL, "Уйти из чата с ботом", true, scenario.days !== undefined);
            const line = await currentApp.openClientLine(`eval-client-${index + 1}-${randomUUID().slice(0, 6)}`, {
              ...(card.startsAt && { startsAt: card.startsAt }),
              ...(card.profileName && { profileName: card.profileName }),
            });
            return await runClientSession({ line, client, startCode, replyLimit: scenario.clientReplies, ...base, ...(scenario.days && { days: scenario.days }) });
          } catch (error) {
            return { ...base, turns: [], clientReplies: 0, endedBy: "error", passage: null, chat: [], error: message(error) };
          }
        }),
      );
    }

    const journal = await app.agentLogErrors();
    run.agentLogErrors = journal.errors;
    if (journal.recovered.length) run.agentLogRecovered = journal.recovered;
    run.usage.agents = await app.usage();
    run.usage.bySource = await app.usageBySource();
  } catch (error) {
    run.runnerErrors.push(message(error));
  } finally {
    try {
      run.usage.personas = totalUsage(await Promise.all(personas.map((item) => item.usage())));
      run.personaRoute = await personaRoute.report();
      await app?.close();
    } catch (error) {
      run.runnerErrors.push(`Закрытие: ${message(error)}`);
    }
    await database.drop().catch((error) => run.runnerErrors.push(`Удаление базы: ${message(error)}`));
    run.durationMs = Date.now() - startedAt.getTime();
  }
  return run;
}
