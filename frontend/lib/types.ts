// ─── 用户 & 会话 ──────────────────────────────────────────────────────────────

export interface UserInfo {
  username: string;
  createdAt: number;
}

export interface SessionInfo {
  sessionId: string;
  title: string;
  code: string;
  library: string;
  videoPath: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionDetail extends SessionInfo {
  messages: ChatMessage[];
}

// SSE 事件类型（来自 backend）
export type AgentEventType =
  | "session_ready"
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "error";

export interface SSEEvent {
  type: AgentEventType;
  [key: string]: any;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "thinking";
  content: string;
  toolName?: string;
  timestamp: number;
}

export interface RenderParams {
  fps: number;
  duration: number;
  width: number;
  height: number;
}

export interface LLMConfig {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  stripThinking?: boolean;
}

export interface SavedModel {
  id: string;
  name: string;
  config: LLMConfig;
}

export type LogEntryKind = "info" | "thinking" | "tool" | "error" | "request";

export interface LogEntry {
  id: string;
  kind: LogEntryKind;
  label: string;
  detail?: string;
  timestamp: number;
}

export interface RenderJob {
  jobId: string;
  status: "pending" | "rendering" | "encoding" | "done" | "error";
  progress: number;
  total: number;
  outputFile?: string;
  error?: string;
}
