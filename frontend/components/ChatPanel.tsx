"use client";

import { useState, useRef, useEffect } from "react";
import type { ChatMessage, LLMConfig } from "@/lib/types";
import { startSession, sendMessage } from "@/lib/api";

interface ChatPanelProps {
  onCodeUpdate: (code: string, library: string) => void;
  llmConfig: LLMConfig | null;
}

export default function ChatPanel({ onCodeUpdate, llmConfig }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [assistantText, setAssistantText] = useState("");
  const [toolStatus, setToolStatus] = useState<string | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const assistantTextRef = useRef<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, assistantText]);

  function handleEvent(event: any) {
    const { type } = event;

    if (type === "session_ready") {
      sessionIdRef.current = event.sessionId;
      return;
    }

    if (type === "agent_start") {
      setIsStreaming(true);
      setAssistantText("");
      setToolStatus(null);
      assistantTextRef.current = "";
      return;
    }

    if (type === "code_update") {
      onCodeUpdate(event.code, event.library ?? "gsap");
      return;
    }

    if (type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (!ae) return;

      if (ae.type === "text_delta") {
        assistantTextRef.current += ae.delta;
        setAssistantText(assistantTextRef.current);
      }

      if (ae.type === "toolcall_start") {
        const partial = ae.partial;
        if (partial?.content) {
          const lastToolCall = [...partial.content]
            .reverse()
            .find((c: any) => c.type === "toolCall");
          if (lastToolCall) {
            if (lastToolCall.name === "write_code") {
              setToolStatus("正在生成代码...");
            } else if (lastToolCall.name === "str_replace") {
              setToolStatus("正在修改代码...");
            }
          }
        }
      }

      if (ae.type === "toolcall_end") {
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
      return;
    }
  }

  async function ensureSession() {
    if (sessionIdRef.current || !llmConfig) return;
    const { sessionId } = await startSession(llmConfig, handleEvent);
    sessionIdRef.current = sessionId;
  }

  async function handleSend() {
    if (!input.trim() || isStreaming || !llmConfig) return;

    const text = input.trim();
    setMessages((prev) => [
      ...prev,
      { id: Date.now().toString(), role: "user", content: text, timestamp: Date.now() },
    ]);
    setInput("");

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
            <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
              msg.role === "user"
                ? "bg-gray-900 text-white rounded-br-sm"
                : "bg-gray-100 text-gray-800 rounded-bl-sm"
            }`}>
              {msg.content}
            </div>
          </div>
        ))}

        {isStreaming && assistantText && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm bg-gray-100 text-gray-800 whitespace-pre-wrap">
              {assistantText}
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
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-xl bg-gray-50 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none focus:ring-2 focus:ring-gray-200"
            placeholder={llmConfig ? "描述动画效果..." : "请先配置 LLM"}
            value={input}
            disabled={isStreaming || !llmConfig}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          />
          <button
            onClick={handleSend}
            disabled={isStreaming || !input.trim() || !llmConfig}
            className="rounded-xl bg-gray-900 text-white px-4 py-2.5 text-sm font-medium disabled:opacity-40 hover:bg-gray-700 transition-colors"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
