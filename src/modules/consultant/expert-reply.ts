import { AGENT_NOTICE_PART_TYPE, type AgentNotice, type StoredMessage } from "@ykurilov/agent-chat-core";

/**
 * Ответ эксперта из «Входящих» лежит в истории консультанта репликой сотрудника SDK (`appendStaffMessage`). До SDK 0.53
 * он лежал сообщением собеседника со своей пометкой — такие остались в идущих чатах; уборка S10 уберёт и это чтение.
 */
const LEGACY_EXPERT_REPLY_PART_TYPE = "data-expert-reply";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Текст ответа эксперта, если сообщение — он (реплика сотрудника или старая пометка); иначе `null`. */
export function expertReplyText(message: Pick<StoredMessage, "parts">): string | null {
  for (const part of message.parts) {
    if (part.type === LEGACY_EXPERT_REPLY_PART_TYPE) {
      const data = (part as { data?: { text?: unknown } }).data;
      return typeof data?.text === "string" ? data.text : "";
    }
    if (part.type === AGENT_NOTICE_PART_TYPE) {
      const data = (part as { data?: unknown }).data;
      const notices: unknown = isRecord(data) ? data.notices : undefined;
      const staff = Array.isArray(notices) ? (notices as AgentNotice[]).find((notice) => isRecord(notice) && notice.kind === "staff") : undefined;
      if (staff) return typeof staff.title === "string" ? staff.title : "";
    }
  }
  return null;
}
