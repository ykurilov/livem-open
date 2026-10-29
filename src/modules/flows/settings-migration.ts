import { eq, sql } from "drizzle-orm";
import { leadMagnetSettingsSchema } from "../lead-magnets/settings";
import { leadMagnets, leadMagnetVersions } from "../lead-magnets/schema";
import { listFields } from "../people";
import type { Database } from "../platform/db";
import { withCurrentFlowRules } from "./program-day";
import { agentFlowOf } from "./runtime";
import { leadMagnetToFlow } from "./settings-to-flow";
import { validateLeadMagnetFlow } from "./validate-flow";

/** Старые настройки без сценария: из них и строится `flow`. */
const legacySettingsSchema = leadMagnetSettingsSchema.omit({ flow: true });

export interface SettingsTranslation {
  /** Сколько черновиков и версий (включая снимки) получили `flow`. */
  drafts: number;
  versions: number;
  /** `draft:<id лидмагнита>` / `version:<id версии>`: старые настройки не разобрались, `flow` не записан. */
  unreadable: string[];
  /** Сценарий записан, но не проходит проверку: эксперт поправит его на доске перед следующим сохранением. */
  withErrors: string[];
  /** Черновики со сценарием до правил 14.10, переписанные по нынешним (`withCurrentFlowRules`). */
  updatedToRules: number;
}

/**
 * Пишет `flow` черновикам, версиям и снимкам, у которых его ещё нет (plan.md, раздел 3.1). Старые `stages` и `program`
 * остаются ради отката. Работник зовёт это после миграций схемы при каждом старте: уже переведённое не трогается.
 */
export async function translateSettingsToFlow(db: Database): Promise<SettingsTranslation> {
  return db.transaction(async (tx) => {
    const fields = await listFields(tx);
    const result: SettingsTranslation = { drafts: 0, versions: 0, unreadable: [], withErrors: [], updatedToRules: 0 };

    const flowOf = (settings: unknown, key: string) => {
      const legacy = legacySettingsSchema.safeParse(settings);
      if (!legacy.success) {
        result.unreadable.push(key);
        return null;
      }
      const flow = leadMagnetToFlow(legacy.data, fields);
      if (!validateLeadMagnetFlow(flow).ok) result.withErrors.push(key);
      return flow;
    };

    const drafts = await tx
      .select({ id: leadMagnets.id, settings: leadMagnets.draft })
      .from(leadMagnets)
      .where(sql`not (${leadMagnets.draft} ? 'flow')`)
      .for("update");
    for (const row of drafts) {
      const flow = flowOf(row.settings, `draft:${row.id}`);
      if (!flow) continue;
      await tx
        .update(leadMagnets)
        .set({ draft: sql`${leadMagnets.draft} || jsonb_build_object('flow', ${JSON.stringify(flow)}::jsonb)` })
        .where(eq(leadMagnets.id, row.id));
      result.drafts += 1;
    }

    const versions = await tx
      .select({ id: leadMagnetVersions.id, settings: leadMagnetVersions.settings })
      .from(leadMagnetVersions)
      .where(sql`not (${leadMagnetVersions.settings} ? 'flow')`)
      .for("update");
    for (const row of versions) {
      const flow = flowOf(row.settings, `version:${row.id}`);
      if (!flow) continue;
      await tx
        .update(leadMagnetVersions)
        .set({ settings: sql`${leadMagnetVersions.settings} || jsonb_build_object('flow', ${JSON.stringify(flow)}::jsonb)` })
        .where(eq(leadMagnetVersions.id, row.id));
      result.versions += 1;
    }

    // Черновик — по нынешним правилам: его видят доска и «Проверка», из него выйдет следующая версия. Версии не трогаются:
    // по ним идут чаты, а снимок без закреплённых чатов перепишет загрузка (`loadLeadMagnetFlow`)
    const withFlow = await tx
      .select({ id: leadMagnets.id, flow: sql<unknown>`${leadMagnets.draft} -> 'flow'` })
      .from(leadMagnets)
      .where(sql`${leadMagnets.draft} ? 'flow'`)
      .for("update");
    for (const row of withFlow) {
      const flow = agentFlowOf(row.flow);
      const current = flow && withCurrentFlowRules(flow);
      if (!current || current === flow) continue;
      await tx
        .update(leadMagnets)
        .set({ draft: sql`jsonb_set(${leadMagnets.draft}, '{flow}', ${JSON.stringify(current)}::jsonb)` })
        .where(eq(leadMagnets.id, row.id));
      result.updatedToRules += 1;
    }
    return result;
  });
}

/** Строки в журнал: что перевели и что требует внимания. Ничего не перевели — молчит. */
export function reportSettingsTranslation(result: SettingsTranslation, log: (line: string) => void = console.log): void {
  if (result.drafts + result.versions > 0) log(`[сценарии] настройки переведены: черновиков ${result.drafts}, версий ${result.versions}`);
  if (result.unreadable.length > 0) log(`[сценарии] не разобраны, сценарий не записан: ${result.unreadable.join(", ")}`);
  if (result.withErrors.length > 0) log(`[сценарии] сценарий с ошибками проверки: ${result.withErrors.join(", ")}`);
  if (result.updatedToRules > 0) log(`[сценарии] черновики по правилам 14.10 (конец через finish_dialog, «Продажа» по дню программы): ${result.updatedToRules}`);
}
