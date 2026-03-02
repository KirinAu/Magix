"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import CodePreviewPanel from "@/components/CodePreviewPanel";
import ChatPanel from "@/components/ChatPanel";
import RenderPanel from "@/components/RenderPanel";
import SettingsModal from "@/components/SettingsModal";
import DebugPanel from "@/components/DebugPanel";
import LoginModal from "@/components/LoginModal";
import SessionSidebar from "@/components/SessionSidebar";
import AssetLibrary from "@/components/AssetLibrary";
import { loadSession, getVideoUrl, saveSessionCode, createSession } from "@/lib/api";
import type { LLMConfig, RenderParams, LogEntry, ChatMessage, UserInfo, SessionInfo, RenderJob, Asset } from "@/lib/types";

const DEFAULT_CODE = `// 在这里写你的动画代码，或者让 AI 帮你生成
// 支持 GSAP 和 Anime.js

const colors = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff'];

for (let i = 0; i < 40; i++) {
  const dot = document.createElement('div');
  dot.style.cssText = \`
    position: absolute;
    width: 8px; height: 8px;
    border-radius: 50%;
    background: \${colors[i % colors.length]};
    left: \${Math.random() * 100}%;
    top: \${Math.random() * 100}%;
  \`;
  document.body.appendChild(dot);

  gsap.fromTo(dot,
    { scale: 0, opacity: 0 },
    {
      scale: 1, opacity: 1,
      duration: 1,
      delay: i * 0.05,
      ease: 'back.out(1.7)',
      repeat: -1,
      yoyo: true,
    }
  );
}`;

export default function Home() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sidebarRefreshTick, setSidebarRefreshTick] = useState(0);
  const [initialMessages, setInitialMessages] = useState<ChatMessage[]>([]);

  const [code, setCode] = useState(DEFAULT_CODE);
  const [library, setLibrary] = useState("gsap");
  const [llmConfig, setLlmConfig] = useState<LLMConfig | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [tab, setTab] = useState<"code" | "preview" | "video">("code");
  const [renderParams, setRenderParams] = useState<RenderParams>({
    fps: 30, duration: 3, width: 1280, height: 720,
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [activeRenderJob, setActiveRenderJob] = useState<RenderJob | null>(null);
  const [showAssetLibrary, setShowAssetLibrary] = useState(false);
  const [assetLibraryRefreshTick, setAssetLibraryRefreshTick] = useState(0);

  // 代码保存状态
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const [lastSavedCode, setLastSavedCode] = useState(DEFAULT_CODE);
  const [lastSavedLibrary, setLastSavedLibrary] = useState("gsap");
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 自动保存逻辑
  const autoSave = useCallback(async () => {
    if (!user || !activeSessionId || saveStatus === "saving") return;
    if (code === lastSavedCode && library === lastSavedLibrary) return;

    setSaveStatus("saving");
    try {
      await saveSessionCode(user.username, activeSessionId, code, library);
      setLastSavedCode(code);
      setLastSavedLibrary(library);
      setSaveStatus("saved");
    } catch (error) {
      console.error("Auto-save failed:", error);
      setSaveStatus("unsaved");
    }
  }, [user, activeSessionId, code, library, lastSavedCode, lastSavedLibrary, saveStatus]);

  // 手动保存
  const handleManualSave = useCallback(async () => {
    if (!user) return;

    // 如果没有 sessionId，先创建一个新会话
    if (!activeSessionId) {
      setSaveStatus("saving");
      try {
        const newSession = await createSession(user.username, "手动保存的代码", code, library);
        setActiveSessionId(newSession.sessionId);
        setLastSavedCode(code);
        setLastSavedLibrary(library);
        setSaveStatus("saved");
        setSidebarRefreshTick((t) => t + 1);

        // 设置初始消息为空，这样就是一个干净的新会话
        setInitialMessages([]);
      } catch (error) {
        console.error("Manual save failed:", error);
        setSaveStatus("unsaved");
      }
      return;
    }

    // 已有会话，直接保存
    setSaveStatus("saving");
    try {
      await saveSessionCode(user.username, activeSessionId, code, library);
      setLastSavedCode(code);
      setLastSavedLibrary(library);
      setSaveStatus("saved");
      setSidebarRefreshTick((t) => t + 1);
    } catch (error) {
      console.error("Manual save failed:", error);
      setSaveStatus("unsaved");
    }
  }, [user, activeSessionId, code, library]);

  // 监听代码变化，设置未保存状态并启动自动保存
  useEffect(() => {
    if (!activeSessionId) return;

    if (code !== lastSavedCode || library !== lastSavedLibrary) {
      setSaveStatus("unsaved");

      // 清除之前的定时器
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      // 3秒后自动保存
      saveTimeoutRef.current = setTimeout(() => {
        autoSave();
      }, 3000);
    }

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [code, library, lastSavedCode, lastSavedLibrary, activeSessionId, autoSave]);
  useEffect(() => {
    const saved = localStorage.getItem("me_user");
    if (saved) {
      try { setUser(JSON.parse(saved)); } catch {}
    }
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => { if (data) setLlmConfig(data); })
      .catch(() => {});
  }, []);

  function handleLogin(u: UserInfo) {
    setUser(u);
    localStorage.setItem("me_user", JSON.stringify(u));
  }

  function handleLogout() {
    setUser(null);
    localStorage.removeItem("me_user");
    setActiveSessionId(null);
    setInitialMessages([]);
    resetWorkspace();
  }

  function resetWorkspace() {
    setCode(DEFAULT_CODE);
    setLibrary("gsap");
    setVideoUrl(null);
    setTab("code");
    setLogs([]);
    setActiveRenderJob(null);
  }

  // 切换到已有会话
  async function handleSelectSession(session: SessionInfo) {
    if (!user) return;
    if (session.sessionId === activeSessionId) return;

    const detail = await loadSession(user.username, session.sessionId);
    if (!detail) return;

    setActiveSessionId(session.sessionId);
    setInitialMessages(detail.messages as ChatMessage[]);
    setCode(detail.code || DEFAULT_CODE);
    setLibrary(detail.library || "gsap");
    setLastSavedCode(detail.code || DEFAULT_CODE);
    setLastSavedLibrary(detail.library || "gsap");
    setSaveStatus("saved");
    setVideoUrl(detail.videoPath ? getVideoUrl(detail.videoPath) : null);
    setTab("code");
    setLogs([]);
    setActiveRenderJob(detail.renderJob ?? null);
  }

  // 新建会话
  function handleNewSession() {
    setActiveSessionId(null);
    setInitialMessages([]);
    resetWorkspace();
    setLastSavedCode(DEFAULT_CODE);
    setLastSavedLibrary("gsap");
    setSaveStatus("saved");
  }

  // agent 创建了新 session 后，更新 activeSessionId 并刷新侧边栏
  async function handleSessionCreated(sessionId: string) {
    setActiveSessionId(sessionId);
    setSidebarRefreshTick((t) => t + 1);

    // 如果用户在新会话中已经编辑了代码，立即保存
    if (user && (code !== DEFAULT_CODE || library !== "gsap")) {
      try {
        await saveSessionCode(user.username, sessionId, code, library);
        setLastSavedCode(code);
        setLastSavedLibrary(library);
        setSaveStatus("saved");
      } catch (error) {
        console.error("Failed to save code on session creation:", error);
      }
    }
  }

  const handleLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => [...prev, entry]);
  }, []);

  const handleLogAppend = useCallback((id: string, delta: string) => {
    setLogs((prev) => prev.map((e) =>
      e.id === id ? { ...e, label: e.label + delta } : e
    ));
  }, []);

  const handlePreviewLog = useCallback((kind: LogEntry["kind"], label: string, detail?: string) => {
    setLogs((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        kind,
        label,
        detail,
        timestamp: Date.now(),
      },
    ]);
  }, []);

  async function handleSaveConfig(config: LLMConfig) {
    setLlmConfig(config);
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    }).catch(() => {});
  }

  function handleCodeUpdate(newCode: string, newLibrary: string) {
    setCode(newCode);
    setLibrary(newLibrary);
    // 代码更新后刷新侧边栏标题
    setSidebarRefreshTick((t) => t + 1);
  }

  function handleRenderDone(jobId: string, outputFile: string) {
    setVideoUrl(getVideoUrl(outputFile));
    setTab("video");
    setSidebarRefreshTick((t) => t + 1);
    setAssetLibraryRefreshTick((t) => t + 1);
    setActiveRenderJob({ jobId, status: "done", progress: 0, total: 0, outputFile });
  }

  return (
    <div className="h-screen bg-gray-50 flex flex-col overflow-hidden">
      {/* 登录弹窗 */}
      {!user && <LoginModal onLogin={handleLogin} />}

      <header className="h-14 bg-white border-b border-gray-100 flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 bg-gray-900 rounded-lg" />
          <span className="text-sm font-semibold text-gray-900">MagicEffect</span>
          <span className="text-xs text-gray-400 bg-gray-100 rounded-full px-2.5 py-0.5">MVP</span>
        </div>

        <div className="flex items-center gap-3">
          {user && (code !== DEFAULT_CODE || library !== "gsap" || activeSessionId) && (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <div className={`w-1.5 h-1.5 rounded-full ${
                  saveStatus === "saved" ? "bg-green-500" :
                  saveStatus === "saving" ? "bg-yellow-500" : "bg-red-500"
                }`} />
                <span className="text-xs text-gray-500">
                  {saveStatus === "saved" ? "已保存" :
                   saveStatus === "saving" ? "保存中..." : "未保存"}
                </span>
              </div>
              {saveStatus === "unsaved" && (
                <button
                  onClick={handleManualSave}
                  className="rounded-lg bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 text-xs font-medium transition-colors"
                >
                  保存
                </button>
              )}
            </div>
          )}
          {user && (
            <>
              <button
                onClick={() => setShowAssetLibrary(true)}
                className="rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200 px-3 py-2 text-xs font-medium transition-colors"
              >
                素材库
              </button>
              <button
                onClick={() => { window.location.href = "/timeline"; }}
                className="rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200 px-3 py-2 text-xs font-medium transition-colors"
              >
                时间线
              </button>
            </>
          )}
          {user && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">{user.username}</span>
              <button
                onClick={handleLogout}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                退出
              </button>
            </div>
          )}
          <button
            onClick={() => setShowSettings(true)}
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-medium transition-colors ${
              llmConfig
                ? "bg-gray-100 text-gray-700 hover:bg-gray-200"
                : "bg-gray-900 text-white hover:bg-gray-700"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${llmConfig ? "bg-green-500" : "bg-gray-400"}`} />
            {llmConfig ? `${llmConfig.provider} · ${llmConfig.modelId}` : "配置 LLM"}
          </button>
        </div>
      </header>

      <main className="flex-1 flex gap-4 p-4 overflow-hidden">
        {/* 会话侧边栏 */}
        {user && (
          <div className="w-48 shrink-0">
            <SessionSidebar
              username={user.username}
              activeSessionId={activeSessionId}
              onSelect={handleSelectSession}
              onNew={handleNewSession}
              refreshTick={sidebarRefreshTick}
            />
          </div>
        )}

        <div className="w-80 shrink-0">
          <ChatPanel
            onCodeUpdate={handleCodeUpdate}
            llmConfig={llmConfig}
            onLog={handleLog}
            onLogAppend={handleLogAppend}
            username={user?.username}
            activeSessionId={activeSessionId}
            initialMessages={initialMessages}
            onSessionCreated={handleSessionCreated}
          />
        </div>

        <div className="flex-1 min-w-0">
          <CodePreviewPanel
            value={code}
            onChange={setCode}
            tab={tab}
            onTabChange={setTab}
            videoUrl={videoUrl}
            renderParams={renderParams}
            library={library}
            onPreviewLog={handlePreviewLog}
          />
        </div>

        <div className="w-64 shrink-0">
          <RenderPanel
            code={code}
            library={library}
            params={renderParams}
            onParamsChange={setRenderParams}
            onRenderDone={handleRenderDone}
            username={user?.username}
            sessionId={activeSessionId ?? undefined}
            initialJob={activeRenderJob}
          />
        </div>
      </main>

      <DebugPanel logs={logs} onClear={() => setLogs([])} />

      {showSettings && (
        <SettingsModal
          config={llmConfig}
          onSave={handleSaveConfig}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showAssetLibrary && user && (
        <AssetLibrary
          username={user.username}
          onClose={() => setShowAssetLibrary(false)}
          refreshTick={assetLibraryRefreshTick}
          onSelectAsset={() => {
            setShowAssetLibrary(false);
            window.location.href = "/timeline";
          }}
        />
      )}
    </div>
  );
}
