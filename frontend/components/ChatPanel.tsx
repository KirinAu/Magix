"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import type { ChatMessage, LLMConfig, LogEntry } from "@/lib/types";
import { startSession, sendMessage, abortSession } from "@/lib/api";

interface ChatPanelProps {
  onCodeUpdate: (code: string, library: string) => void;
  llmConfig: LLMConfig | null;
  onLog: (entry: LogEntry) => void;
  onLogAppend: (id: string, delta: string) => void;
  username?: string;
  initialMessages?: ChatMessage[];
  onSessionCreated?: (sessionId: string) => void;
}

export default function ChatPanel({ onCodeUpdate, llmConfig, onLog, onLogAppend, username, initialMessages, onSessionCreated }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages ?? []);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [assistantText, setAssistantText] = useState("");
  const [toolStatus, setToolStatus] = useState<string | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const assistantTextRef = useRef<string>("");
  const currentToolNameRef = useRef<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const thinkingLogIdRef = useRef<string | null>(null);
  const thinkingTextRef = useRef<string>("");

  function mkId() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

  function detectLibraryFromCode(code: string): string {
    if (code.includes("THREE")) return "three";
    if (code.includes("PIXI")) return "pixi";
    if (code.includes("anime(") || code.includes("anime.")) return "anime";
    return "gsap";
  }

  function extractLatestJsCodeBlock(text: string): string | null {
    const re = /```(?:javascript|js)?\n([\s\S]*?)```/gi;
    let match: RegExpExecArray | null = null;
    let last: string | null = null;
    while ((match = re.exec(text)) !== null) {
      last = match[1];
    }
    return last ? last.trim() : null;
  }

  useEffect(() => {
    // 切换会话时重置状态
    setMessages(initialMessages ?? []);
    sessionIdRef.current = null;
    assistantTextRef.current = "";
    setAssistantText("");
    setIsStreaming(false);
    setToolStatus(null);
  }, [initialMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, assistantText]);

  function handleEvent(event: any) {
    const { type } = event;

    if (type === "session_ready") {
      sessionIdRef.current = event.sessionId;
      return;
    }

    if (type === "error") {
      setIsStreaming(false);
      setToolStatus(null);
      // 清掉坏掉的 session，下次发消息重新建
      sessionIdRef.current = null;
      const errMsg = event.message || "未知错误";
      onLog({ id: mkId(), kind: "error", label: errMsg, timestamp: Date.now() });
      setMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), role: "assistant", content: `**错误：** ${errMsg}`, timestamp: Date.now() },
      ]);
      assistantTextRef.current = "";
      setAssistantText("");
      return;
    }

    if (type === "agent_start") {
      setIsStreaming(true);
      setAssistantText("");
      setToolStatus(null);
      assistantTextRef.current = "";
      thinkingLogIdRef.current = null;
      onLog({ id: mkId(), kind: "info", label: "agent_start", timestamp: Date.now() });
      return;
    }

    if (type === "turn_start") {
      onLog({ id: mkId(), kind: "info", label: "turn_start", timestamp: Date.now() });
      return;
    }

    if (type === "tool_execution_start") {
      onLog({ id: mkId(), kind: "tool", label: `tool_start: ${event.toolName}`, detail: JSON.stringify(event.args, null, 2), timestamp: Date.now() });
      return;
    }

    if (type === "tool_execution_end") {
      onLog({ id: mkId(), kind: "tool", label: `tool_end: ${event.toolName}${event.isError ? " [ERROR]" : ""}`, timestamp: Date.now() });
      return;
    }

    if (type === "code_update") {
      onCodeUpdate(event.code, event.library ?? "gsap");
      return;
    }

    if (type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (!ae) return;

      if (ae.type === "thinking_start") {
        const id = mkId();
        thinkingLogIdRef.current = id;
        thinkingTextRef.current = "";
        onLog({ id, kind: "thinking", label: "", timestamp: Date.now() });
      }

      if (ae.type === "thinking_delta") {
        thinkingTextRef.current += ae.delta;
        if (thinkingLogIdRef.current) {
          onLogAppend(thinkingLogIdRef.current, ae.delta);
        }
      }

      if (ae.type === "thinking_end") {
        const text = thinkingTextRef.current.trim();
        if (text) {
          setMessages((prev) => [
            ...prev,
            { id: mkId(), role: "thinking", content: text, timestamp: Date.now() },
          ]);
        }
        thinkingTextRef.current = "";
        thinkingLogIdRef.current = null;
      }

      if (ae.type === "text_delta") {
        assistantTextRef.current += ae.delta;
        setAssistantText(assistantTextRef.current);
        const partialCode = extractLatestJsCodeBlock(assistantTextRef.current);
        if (partialCode) {
          onCodeUpdate(partialCode, detectLibraryFromCode(partialCode));
        }
      }

      if (ae.type === "toolcall_delta") {
        const partial = ae.partial;
        if (partial?.content) {
          const lastToolCall = [...partial.content]
            .reverse()
            .find((c: any) => c.type === "toolCall");
          if (lastToolCall) {
            currentToolNameRef.current = lastToolCall.name;
            if (lastToolCall.name === "commit_code") {
              setToolStatus("正在提交代码...");
            } else if (lastToolCall.name === "str_replace") {
              setToolStatus("正在修改代码...");
            } else if (lastToolCall.name === "read_code") {
              setToolStatus("正在查看代码...");
            } else if (lastToolCall.name === "validate_code") {
                      setToolStatus("正在检查代码...");
                    }
          }
        }
      }

      if (ae.type === "toolcall_end") {
        const name = currentToolNameRef.current;
        const label = name === "commit_code" ? "提交代码" : name === "str_replace" ? "修改代码" : name === "read_code" ? "查看代码" : "检查代码";
        setMessages((prev) => [
          ...prev,
          { id: Date.now().toString(), role: "tool", content: label, toolName: name, timestamp: Date.now() },
        ]);
        currentToolNameRef.current = "";
        setToolStatus(null);
      }
    }

    if (type === "turn_end") {
      const text = assistantTextRef.current.trim();
      assistantTextRef.current = "";
      setAssistantText("");
      if (text) {
        setMessages((prev) => [
          ...prev,
          { id: Date.now().toString(), role: "assistant", content: text, timestamp: Date.now() },
        ]);
      }
      return;
    }

    if (type === "agent_end") {
      // 兜底：turn_end 已经处理了，这里只负责收尾状态
      setIsStreaming(false);
      setAssistantText("");
      assistantTextRef.current = "";
      onLog({ id: mkId(), kind: "info", label: "agent_end", timestamp: Date.now() });
      return;
    }
  }

  async function ensureSession() {
    if (sessionIdRef.current || !llmConfig) return;
    const { sessionId } = await startSession(llmConfig, handleEvent, username);
    sessionIdRef.current = sessionId;
    onSessionCreated?.(sessionId);
  }

  async function handleAbort() {
    if (!sessionIdRef.current) return;
    await abortSession(sessionIdRef.current);
    setIsStreaming(false);
    setToolStatus(null);
    const text = assistantTextRef.current.trim();
    assistantTextRef.current = "";
    setAssistantText("");
    if (text) {
      setMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), role: "assistant", content: text, timestamp: Date.now() },
      ]);
    }
  }

  async function handleSend() {
    if (!input.trim() || isStreaming || !llmConfig) return;

    const text = input.trim();
    setMessages((prev) => [
      ...prev,
      { id: Date.now().toString(), role: "user", content: text, timestamp: Date.now() },
    ]);
    setInput("");
    setIsStreaming(true);
    onLog({ id: mkId(), kind: "request", label: `sendMessage: "${text}"`, detail: JSON.stringify(llmConfig, null, 2), timestamp: Date.now() });

    await ensureSession();
    if (!sessionIdRef.current) return;

    await sendMessage(sessionIdRef.current, text, handleEvent);
  }

  return (
    <div className="flex flex-col h-full bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100">
        <p className="text-sm font-semibold text-gray-900">AI 助手</p>
        <p className="text-xs text-gray-400 mt-0.5">描述你想要的动画效果</p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && !isStreaming && (
          <div className="text-center text-gray-400 text-sm mt-8">
            <p>告诉我你想要什么动画</p>
            <p className="mt-1 text-xs">例如：做一个粒子爆炸效果，用 GSAP</p>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "tool" ? (
              <div className="flex items-center gap-2 rounded-xl px-3 py-1.5 bg-gray-50 border border-gray-100">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                <span className="text-xs text-gray-400">{msg.content}</span>
              </div>
            ) : msg.role === "thinking" ? (
              <details className="max-w-[85%] rounded-2xl rounded-bl-sm px-4 py-2.5 bg-gray-50 border border-gray-100">
                <summary className="text-xs text-gray-400 cursor-pointer select-none">思考过程</summary>
                <p className="mt-2 text-xs text-gray-400 whitespace-pre-wrap leading-relaxed">{msg.content}</p>
              </details>
            ) : (
              <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                msg.role === "user"
                  ? "bg-gray-900 text-white rounded-br-sm whitespace-pre-wrap"
                  : "bg-gray-100 text-gray-800 rounded-bl-sm prose prose-sm max-w-none"
              }`}>
                {msg.role === "user" ? msg.content : <ReactMarkdown>{msg.content}</ReactMarkdown>}
              </div>
            )}
          </div>
        ))}

        {isStreaming && assistantText && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm bg-gray-100 text-gray-800 prose prose-sm max-w-none">
              <ReactMarkdown>{assistantText}</ReactMarkdown>
              <span className="inline-block w-1 h-3.5 bg-gray-400 ml-0.5 animate-pulse align-middle" />
            </div>
          </div>
        )}

        {isStreaming && toolStatus && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm px-4 py-2.5 bg-gray-50 border border-gray-100">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse" />
              <span className="text-xs text-gray-500">{toolStatus}</span>
            </div>
          </div>
        )}

        {isStreaming && !assistantText && !toolStatus && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm px-4 py-3 bg-gray-100">
              <div className="flex gap-1 items-center">
                {[0, 150, 300].map((delay) => (
                  <span
                    key={delay}
                    className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="px-4 py-3 border-t border-gray-100">
        <div className="flex gap-2 items-end">
          <input
            className="flex-1 rounded-xl bg-gray-50 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none focus:ring-2 focus:ring-gray-200"
            placeholder={llmConfig ? "描述动画效果..." : "请先配置 LLM"}
            value={input}
            disabled={isStreaming || !llmConfig}
            onChange={(e) => setInput(e.target.value)}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !isComposingRef.current) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          {isStreaming ? (
            <button
              onClick={handleAbort}
              className="shrink-0 rounded-xl bg-red-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-red-600 transition-colors"
            >
              停止
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim() || !llmConfig}
              className="shrink-0 rounded-xl bg-gray-900 text-white px-4 py-2.5 text-sm font-medium disabled:opacity-40 hover:bg-gray-700 transition-colors"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
