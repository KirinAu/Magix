"use client";

import { useState, useRef, useEffect } from "react";import ReactMarkdown from "react-markdown";
import type { ChatMessage, LLMConfig, LogEntry } from "@/lib/types";
import { startSession, sendMessage, abortSession } from "@/lib/api";

interface ChatPanelProps {
  onCodeUpdate: (code: string, library: string) => void;
  llmConfig: LLMConfig | null;
  onLog: (entry: LogEntry) => void;
  onLogAppend: (id: string, delta: string) => void;
  username?: string;
  activeSessionId?: string | null;
  initialMessages?: ChatMessage[];
  onSessionCreated?: (sessionId: string) => void;
}

export default function ChatPanel({ onCodeUpdate, llmConfig, onLog, onLogAppend, username, activeSessionId, initialMessages, onSessionCreated }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages ?? []);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [assistantText, setAssistantText] = useState("");
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [thinkingText, setThinkingText] = useState("");

  const sessionIdRef = useRef<string | null>(null);
  const assistantTextRef = useRef<string>("");
  const currentToolNameRef = useRef<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const thinkingLogIdRef = useRef<string | null>(null);
  const thinkingTextRef = useRef<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [pendingImages, setPendingImages] = useState<Array<{ type: "base64"; mediaType: string; data: string; preview: string }>>([]);

  function mkId() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

  useEffect(() => {
    // 切换会话时重置状态
    setMessages(initialMessages ?? []);
    sessionIdRef.current = activeSessionId ?? null;
    assistantTextRef.current = "";
    setAssistantText("");
    setIsStreaming(false);
    setToolStatus(null);
    setThinkingText("");
  }, [initialMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, assistantText, toolStatus, thinkingText]);

  function handleEvent(event: any) {
    const { type } = event;

    if (type === "session_ready") {
      sessionIdRef.current = event.sessionId;
      if (event.sessionId) onSessionCreated?.(event.sessionId);
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
      setThinkingText("");
      return;
    }

    if (type === "context_debug") {
      const msgs: Array<{role: string; content: string; toolName?: string; toolArgs?: any}> = event.messages ?? [];
      const summary = msgs.map((m, i) => {
        const roleTag = m.role === "tool" ? `[tool/${m.toolName}]` : `[${m.role}]`;
        const preview = m.content.length > 120 ? m.content.slice(0, 120) + "..." : m.content;
        return `${i + 1}. ${roleTag} ${preview}`;
      }).join("\n");
      onLog({ id: mkId(), kind: "info", label: `context (${msgs.length} msgs) → LLM`, detail: summary || "(empty)", timestamp: Date.now() });
      return;
    }

    if (type === "tool_result_debug") {
      onLog({ id: mkId(), kind: "tool", label: `tool_result: ${event.toolName}`, detail: event.result, timestamp: Date.now() });
      return;
    }

    if (type === "request_debug") {
      const histLen = event.historyLength ?? 0;
      const detail = JSON.stringify({ userMessage: event.userMessage, history: event.history }, null, 2);
      onLog({ id: mkId(), kind: "request", label: `→ 发送请求 (历史 ${histLen} 条)`, detail, timestamp: Date.now() });
      return;
    }

    if (type === "agent_start") {
      setIsStreaming(true);
      setAssistantText("");
      setToolStatus(null);
      setThinkingText("");
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
        setThinkingText("");
        onLog({ id, kind: "thinking", label: "", timestamp: Date.now() });
      }

      if (ae.type === "thinking_delta") {
        thinkingTextRef.current += ae.delta;
        setThinkingText(thinkingTextRef.current);
        if (thinkingLogIdRef.current) {
          onLogAppend(thinkingLogIdRef.current, ae.delta);
        }
      }

      if (ae.type === "thinking_end") {
        thinkingTextRef.current = "";
        setThinkingText("");
        thinkingLogIdRef.current = null;
      }

      if (ae.type === "text_delta") {
        assistantTextRef.current += ae.delta;
        setAssistantText(assistantTextRef.current);
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
      setThinkingText("");
      setToolStatus(null);
      if (text) {
        setMessages((prev) => [
          ...prev,
          { id: Date.now().toString(), role: "assistant", content: text, timestamp: Date.now() },
        ]);
        onLog({
          id: mkId(),
          kind: "info",
          label: "turn_end",
          detail: text,
          timestamp: Date.now(),
        });
      } else {
        onLog({ id: mkId(), kind: "info", label: "turn_end (no assistant text)", timestamp: Date.now() });
      }
      return;
    }

    if (type === "agent_end") {
      // 兜底：turn_end 已经处理了，这里只负责收尾状态
      setIsStreaming(false);
      setAssistantText("");
      setThinkingText("");
      setToolStatus(null);
      assistantTextRef.current = "";
      onLog({ id: mkId(), kind: "info", label: "agent_end", timestamp: Date.now() });
      return;
    }
  }

  async function ensureSession() {
    if (sessionIdRef.current || !llmConfig) return;
    const { sessionId } = await startSession(llmConfig, handleEvent, username);
    if (sessionId) {
      sessionIdRef.current = sessionId;
    }
  }

  async function handleAbort() {
    if (!sessionIdRef.current) return;
    await abortSession(sessionIdRef.current);
    setIsStreaming(false);
    setToolStatus(null);
    setThinkingText("");
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
    const imgs = pendingImages.map(({ type, mediaType, data }) => ({ type, mediaType, data }));
    setMessages((prev) => [
      ...prev,
      { id: Date.now().toString(), role: "user", content: text, timestamp: Date.now(), images: pendingImages.map(i => i.preview) },
    ]);
    setInput("");
    setPendingImages([]);
    setIsStreaming(true);
    onLog({ id: mkId(), kind: "request", label: `sendMessage: "${text}"`, detail: JSON.stringify(llmConfig, null, 2), timestamp: Date.now() });

    try {
      await ensureSession();
      if (!sessionIdRef.current) throw new Error("会话创建失败");
      await sendMessage(sessionIdRef.current, text, handleEvent, imgs.length > 0 ? imgs : undefined, username, llmConfig);
    } catch (err: any) {
      const errMsg = err?.message || "发送失败";
      setIsStreaming(false);
      setToolStatus(null);
      onLog({ id: mkId(), kind: "error", label: errMsg, timestamp: Date.now() });
      setMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), role: "assistant", content: `**错误：** ${errMsg}`, timestamp: Date.now() },
      ]);
    }
  }

  async function handleImageFiles(files: FileList | null) {
    if (!files) return;
    const results: Array<{ type: "base64"; mediaType: string; data: string; preview: string }> = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const data = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve((e.target?.result as string).split(",")[1]);
        reader.readAsDataURL(file);
      });
      const preview = URL.createObjectURL(file);
      results.push({ type: "base64", mediaType: file.type, data, preview });
    }
    setPendingImages((prev) => [...prev, ...results]);
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
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-center"}`}>
            {msg.role === "tool" ? (
              <div className="flex items-center gap-2 rounded-full px-3 py-1 text-xs text-gray-500 border border-gray-200 bg-gray-50">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                <span>{msg.content}</span>
              </div>
            ) : msg.role === "thinking" ? (
              <details className="max-w-[90%] text-center text-xs text-gray-400">
                <summary className="text-xs text-gray-400 cursor-pointer select-none">思考过程</summary>
                <p className="mt-2 text-xs text-gray-400 whitespace-pre-wrap leading-relaxed">{msg.content}</p>
              </details>
            ) : (
              <div className={`max-w-[90%] text-sm ${
                msg.role === "user"
                  ? "text-gray-900 text-right"
                  : "text-gray-800 text-center prose prose-sm max-w-none"
              }`}>
                {msg.role === "user" ? (
                  <div className="space-y-2">
                    {msg.images && msg.images.length > 0 && (
                      <div className="flex gap-1.5 flex-wrap">
                        {msg.images.map((src, i) => (
                          <img key={i} src={src} className="w-20 h-20 rounded-lg object-cover opacity-90" />
                        ))}
                      </div>
                    )}
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  </div>
                ) : (
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                )}
              </div>
            )}
          </div>
        ))}

        {isStreaming && (assistantText || thinkingText || toolStatus) && (
          <div className="flex justify-center">
            <div className="max-w-[90%] text-sm text-center text-gray-700 prose prose-sm max-w-none">
              {thinkingText && (
                <p className="whitespace-pre-wrap text-xs text-gray-400 mb-2">
                  <span className="font-medium">Thinking:</span> {thinkingText}
                </p>
              )}
              {toolStatus && (
                <p className="text-xs text-gray-500 mb-2 inline-flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse" />
                  {toolStatus}
                </p>
              )}
              <ReactMarkdown>{assistantText}</ReactMarkdown>
              <span className="inline-block w-1 h-3.5 bg-gray-400 ml-0.5 animate-pulse align-middle" />
            </div>
          </div>
        )}

        {isStreaming && !assistantText && !toolStatus && !thinkingText && (
          <div className="flex justify-center">
            <div className="px-4 py-3">
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

      <div className="px-4 py-3 border-t border-gray-100 space-y-2">
        {/* 图片预览 */}
        {pendingImages.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative">
                <img src={img.preview} className="w-14 h-14 rounded-xl object-cover border border-gray-200" />
                <button
                  onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-gray-900 text-white text-xs flex items-center justify-center leading-none"
                >×</button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 items-end">
          {/* 图片上传按钮 */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => handleImageFiles(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isStreaming}
            className="shrink-0 rounded-xl border border-gray-200 text-gray-400 px-3 py-2.5 text-sm hover:bg-gray-50 disabled:opacity-40 transition-colors"
            title="上传参考图"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
            </svg>
          </button>

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
