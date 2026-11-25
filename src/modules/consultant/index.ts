export { buildConsultantInstruction } from "./instruction";
export { leadMagnetKnownTexts } from "./known-texts";
export { buildConsultantTail } from "./tail";
export type { AfterEndTail } from "./tail";
export { AGENT_HANDOVER_PREFIX, HAND_TO_EXPERT_TOOL } from "./expert-handover";
export type { ExpertHandoverPort } from "./expert-handover";
export { CONSULTANT_TOOL_NAMES, createConsultantTools } from "./tools";
export { createPreviewConversationStore, readPreviewConversation, startPreviewConversation } from "./preview-store";
export type { ConversationStore, PreviewConversation } from "./preview-store";
export { SALE_REASONS, appClosingAfter } from "./schema";
export type {
  AppClosing,
  DialogOutcome,
  DialogSummary,
  FieldValue,
  PassageSideTasks,
  SaleAnswer,
  SaleReason,
  StageChangedBy,
  StageHistoryEntry,
} from "./schema";
export { consultantAgentSettings, VersionCache } from "./services";
export { PREVIEW_BASE_PATH, createPreviewEndpoint } from "./preview-endpoint";
export type { ConsultantTrialInput, PreviewEndpoint, PreviewEndpointOptions, PreviewCallBooking, PreviewMessengerHandoff, PreviewStatus } from "./preview-endpoint";
