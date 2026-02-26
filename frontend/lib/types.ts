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
  role: "user" | "assistant" | "tool";
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
