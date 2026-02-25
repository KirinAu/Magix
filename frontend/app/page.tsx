"use client";

import { useState, useEffect } from "react";
import CodePreviewPanel from "@/components/CodePreviewPanel";
import ChatPanel from "@/components/ChatPanel";
import RenderPanel from "@/components/RenderPanel";
import SettingsModal from "@/components/SettingsModal";
import type { LLMConfig } from "@/lib/types";

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
  const [code, setCode] = useState(DEFAULT_CODE);
  const [library, setLibrary] = useState("gsap");
  const [llmConfig, setLlmConfig] = useState<LLMConfig | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [doneJobId, setDoneJobId] = useState<string | null>(null);
  const [tab, setTab] = useState<"code" | "video">("code");

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => { if (data) setLlmConfig(data); })
      .catch(() => {});
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
  }

  function handleRenderDone(jobId: string) {
    setDoneJobId(jobId);
    setTab("video");
  }

  return (
    <div className="h-screen bg-gray-50 flex flex-col overflow-hidden">
      <header className="h-14 bg-white border-b border-gray-100 flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 bg-gray-900 rounded-lg" />
          <span className="text-sm font-semibold text-gray-900">MagicEffect</span>
          <span className="text-xs text-gray-400 bg-gray-100 rounded-full px-2.5 py-0.5">MVP</span>
        </div>

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
      </header>

      <main className="flex-1 flex gap-4 p-4 overflow-hidden">
        <div className="w-72 shrink-0">
          <ChatPanel onCodeUpdate={handleCodeUpdate} llmConfig={llmConfig} />
        </div>

        <div className="flex-1 min-w-0">
          <CodePreviewPanel
            value={code}
            onChange={setCode}
            tab={tab}
            onTabChange={setTab}
            doneJobId={doneJobId}
          />
        </div>

        <div className="w-64 shrink-0">
          <RenderPanel code={code} library={library} onRenderDone={handleRenderDone} />
        </div>
      </main>

      {showSettings && (
        <SettingsModal
          config={llmConfig}
          onSave={handleSaveConfig}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
