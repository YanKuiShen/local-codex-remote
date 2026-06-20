export type ClientEventType = "user_message" | "ping";

export type ServerEventType =
  | "connection_ready"
  | "pong"
  | "assistant_started"
  | "assistant_delta"
  | "assistant_done"
  | "error";

export type ChatRole = "user" | "assistant" | "system";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface BaseEvent {
  id: string;
  type: string;
  sessionId: string;
  timestamp: string;
}

export interface UserMessageEvent extends BaseEvent {
  type: "user_message";
  messageId: string;
  text: string;
  settings?: ChatRunSettings;
}

export interface PingEvent extends BaseEvent {
  type: "ping";
}

export type ClientEvent = UserMessageEvent | PingEvent;

export interface ConnectionReadyEvent extends BaseEvent {
  type: "connection_ready";
}

export interface PongEvent extends BaseEvent {
  type: "pong";
}

export interface AssistantStartedEvent extends BaseEvent {
  type: "assistant_started";
  messageId: string;
}

export interface AssistantDeltaEvent extends BaseEvent {
  type: "assistant_delta";
  messageId: string;
  delta: string;
}

export interface AssistantDoneEvent extends BaseEvent {
  type: "assistant_done";
  messageId: string;
}

export interface ErrorEvent extends BaseEvent {
  type: "error";
  message: string;
  code?: string;
  messageId?: string;
}

export type ServerEvent =
  | ConnectionReadyEvent
  | PongEvent
  | AssistantStartedEvent
  | AssistantDeltaEvent
  | AssistantDoneEvent
  | ErrorEvent;

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  status: "sending" | "streaming" | "sent" | "failed";
  timestamp: string;
}

export interface AgentInput {
  sessionId: string;
  messageId: string;
  text: string;
  settings?: ChatRunSettings;
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type SpeedTier = "standard" | "fast";

export type ApprovalPolicy = "never" | "on-request";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface ChatRunSettings {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  speed?: SpeedTier;
  approvalPolicy?: ApprovalPolicy;
  sandboxMode?: SandboxMode;
}

export interface CodexModelOption {
  value: string;
  label: string;
  defaultReasoningEffort?: ReasoningEffort;
  reasoningEfforts: ReasoningEffort[];
  speedTiers: SpeedTier[];
}

export const FALLBACK_CODEX_MODELS: CodexModelOption[] = [
  { value: "gpt-5.5", label: "GPT-5.5", defaultReasoningEffort: "medium", reasoningEfforts: ["low", "medium", "high", "xhigh"], speedTiers: ["standard", "fast"] },
  { value: "gpt-5.4", label: "GPT-5.4", defaultReasoningEffort: "medium", reasoningEfforts: ["low", "medium", "high", "xhigh"], speedTiers: ["standard", "fast"] },
  { value: "gpt-5.4-mini", label: "GPT-5.4-Mini", defaultReasoningEffort: "medium", reasoningEfforts: ["low", "medium", "high", "xhigh"], speedTiers: ["standard"] },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark", defaultReasoningEffort: "high", reasoningEfforts: ["low", "medium", "high", "xhigh"], speedTiers: ["standard"] }
];

export function getCodexModelCapability(models: CodexModelOption[], model: string | undefined): CodexModelOption {
  const fallback = FALLBACK_CODEX_MODELS.find((option) => option.value === model) ?? FALLBACK_CODEX_MODELS[0];
  if (!model) {
    return fallback;
  }

  return models.find((option) => option.value === model) ?? fallback;
}

export function getEffectiveChatRunSettings(settings: ChatRunSettings, models = FALLBACK_CODEX_MODELS): ChatRunSettings {
  const capability = getCodexModelCapability(models, settings.model);
  const next: ChatRunSettings = {
    model: settings.model,
    approvalPolicy: settings.approvalPolicy,
    sandboxMode: settings.sandboxMode
  };

  if (settings.reasoningEffort && capability.reasoningEfforts.includes(settings.reasoningEffort)) {
    next.reasoningEffort = settings.reasoningEffort;
  }

  if (settings.speed && settings.speed !== "standard" && capability.speedTiers.includes(settings.speed)) {
    next.speed = settings.speed;
  }

  return next;
}

export interface AgentChunk {
  text: string;
}

export interface CodexAgent {
  respond(input: AgentInput): AsyncIterable<AgentChunk>;
}

export interface CodexThreadSummary {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  source: string;
  updatedAt: number;
  createdAt: number;
  active: boolean;
}

export interface CodexProjectGroup {
  cwd: string;
  name: string;
  kind: "project" | "api";
  active?: boolean;
  threads: CodexThreadSummary[];
}

export interface CodexThreadMessages {
  threadId: string;
  messages: ChatMessage[];
}

export function createId(prefix: string): string {
  const randomId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 11) + Date.now().toString(36).slice(-6);

  return `${prefix}_${randomId}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseClientEvent(raw: string): ClientEvent | null {
  try {
    const value = JSON.parse(raw) as Partial<ClientEvent>;

    if (!value || typeof value !== "object") {
      return null;
    }

    if (value.type === "ping" && isBaseEvent(value)) {
      return value as PingEvent;
    }

    if (
      value.type === "user_message" &&
      isBaseEvent(value) &&
      typeof value.messageId === "string" &&
      typeof value.text === "string" &&
      value.text.trim().length > 0
    ) {
      return value as UserMessageEvent;
    }

    return null;
  } catch {
    return null;
  }
}

function isBaseEvent(value: Partial<BaseEvent>): value is BaseEvent {
  return (
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.timestamp === "string"
  );
}
