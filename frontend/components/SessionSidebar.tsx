"use client";

import { useEffect, useState } from "react";
import { listUserSessions, deleteUserSession } from "@/lib/api";
import type { SessionInfo } from "@/lib/types";

interface SessionSidebarProps {
  username: string;
  activeSessionId: string | null;
  onSelect: (session: SessionInfo) => void;
  onNew: () => void;
  refreshTick: number; // 外部递增触发刷新
}

export default function SessionSidebar({
  username,
  activeSessionId,
  onSelect,
  onNew,
  refreshTick,
}: SessionSidebarProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  useEffect(() => {
    listUserSessions(username).then(setSessions);
  }, [username, refreshTick]);

  async function handleDelete(e: React.MouseEvent, sessionId: string) {
    e.stopPropagation();
    await deleteUserSession(username, sessionId);
    setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
  }

  function formatTime(ts: number) {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }

  return (
    <div className="flex flex-col h-full bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      {/* 头部 */}
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
        <div>
          <p className="text-xs font-semibold text-gray-900">{username}</p>
          <p className="text-xs text-gray-400">{sessions.length} 个会话</p>
        </div>
        <button
          onClick={onNew}
          className="rounded-xl bg-gray-900 text-white px-3 py-1.5 text-xs font-medium hover:bg-gray-700 transition-colors"
        >
          + 新建
        </button>
      </div>

      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto py-2">
        {sessions.length === 0 && (
          <p className="text-xs text-gray-400 text-center mt-6 px-4">还没有会话，点击新建开始</p>
        )}
        {sessions.map((s) => (
          <div
            key={s.sessionId}
            onClick={() => onSelect(s)}
            className={`group mx-2 mb-1 rounded-xl px-3 py-2.5 cursor-pointer transition-colors flex items-start justify-between gap-2 ${
              s.sessionId === activeSessionId
                ? "bg-gray-900 text-white"
                : "hover:bg-gray-50 text-gray-700"
            }`}
          >
            <div className="flex-1 min-w-0">
              <p className={`text-xs font-medium truncate ${s.sessionId === activeSessionId ? "text-white" : "text-gray-800"}`}>
                {s.title || "新会话"}
              </p>
              <div className="flex items-center gap-1.5 mt-0.5">
                {s.videoPath && (
                  <span className={`text-xs ${s.sessionId === activeSessionId ? "text-gray-300" : "text-gray-400"}`}>
                    🎬
                  </span>
                )}
                <span className={`text-xs ${s.sessionId === activeSessionId ? "text-gray-400" : "text-gray-400"}`}>
                  {formatTime(s.updatedAt)}
                </span>
              </div>
            </div>
            <button
              onClick={(e) => handleDelete(e, s.sessionId)}
              className={`shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-xs px-1.5 py-0.5 rounded-lg ${
                s.sessionId === activeSessionId
                  ? "hover:bg-white/20 text-gray-300"
                  : "hover:bg-gray-200 text-gray-400"
              }`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
