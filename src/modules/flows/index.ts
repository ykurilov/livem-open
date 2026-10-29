// Сценарии SDK для лидмагнитов. Перевод старых настроек, каталог и проверки — общее для
// движка хода, доски, конструктора и консольной команды.
export { LEAD_MAGNET_TOOLS, clientCardFieldOf, leadMagnetFlowCatalog } from "./catalog";
export {
  CONVERSATION_NUDGES,
  CONVERSATION_STATE_ID,
  DEADLINE_STATE_ID,
  FINAL_STATE_ID,
  HARD_DAY_FRAME_TEXT,
  LATE_START_HOURS,
  LEAD_MAGNET_FLOW_ID,
  PROGRAM_DAY_START,
  PROGRAM_FIRST_MESSAGES_BY_DAY,
  PROGRAM_NUDGES,
  SALE_TAG,
  STAFF_SILENCE_HOURS,
  leadMagnetToFlow,
} from "./settings-to-flow";
export type { LeadMagnetFlowSource } from "./settings-to-flow";
export { EARLIEST_DAY_START, PROGRAM_MAX_DAYS, PROGRAM_MIN_DAYS, leadMagnetFlowChecks } from "./app-checks";
export { endExitIssues, withFinishDialogEnds } from "./end-exits";
export { withCurrentFlowRules, withProgramDaySale, withProgramDayTimers } from "./program-day";
export type { FlowAppChecks } from "./app-checks";
export { flowIssuePath, leadMagnetFlowIssues, validateLeadMagnetFlow } from "./validate-flow";
export type { FlowSettingsFinding, FlowSettingsIssue, FlowValidation } from "./validate-flow";
export { cardFromDictionary, completeFlowJson, scheduleWithDefaults, withLeadMagnetFlow, withStateTools } from "./flow-settings";
export { reportSettingsTranslation, translateSettingsToFlow } from "./settings-migration";
export type { SettingsTranslation } from "./settings-migration";
export { FIRST_MESSAGES_PER_DAY, FIRST_MESSAGES_QUIET_HOURS, createLeadMagnetFlow, loadLeadMagnetFlow } from "./runtime";
export type { LeadMagnetFlow, LeadMagnetFlowOptions } from "./runtime";
export { leadMagnetFlowEvents, passageStatusOf, stageHistoryEntryOf } from "./events";
export type { LeadMagnetFlowEvents } from "./events";
export { leadMagnetClientCard } from "./client-card";
export { leadMagnetPeople } from "./people";
export { ChatMigrationError, migrateLiveChats, planChatMigration, requeuePendingChatMigrations } from "./chat-migration";
export type { ChatMigrationPlan, OldVersionGroup, StateMap } from "./chat-migration";
