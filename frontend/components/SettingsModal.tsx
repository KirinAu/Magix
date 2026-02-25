"use client";

import { useState } from "react";
import type { LLMConfig } from "@/lib/types";

interface SettingsModalProps {
  config: LLMConfig | null;
  onSave: (config: LLMConfig) => void;
  onClose: () => void;
}

const PROVIDER_PRESETS: Record<string, { baseUrl: string; placeholder: string }> = {
  anthropic: { baseUrl: "https://api.anthropic.com", placeholder: "claude-sonnet-4-20250514" },
  openai: { baseUrl: "https://api.openai.com", placeholder: "gpt-4o" },
  custom: { baseUrl: "", placeholder: "model-name" },
};

export default function SettingsModal({ config, onSave, onClose }: SettingsModalProps) {
  const [provider, setProvider] = useState(config?.provider ?? "anthropic");
  const [modelId, setModelId] = useState(config?.modelId ?? "");
  const [apiKey, setApiKey] = useState(config?.apiKey ?? "");
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? "");

  function handleProviderChange(p: string) {
    setProvider(p);
    if (p !== "custom") {
      setBaseUrl(PROVIDER_PRESETS[p]?.baseUrl ?? "");
    }
  }

  function handleSave() {
    if (!apiKey.trim() || !modelId.trim()) return;
    onSave({
      provider,
      modelId: modelId.trim(),
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim() || undefined,
    });
    onClose();
  }

  const preset = PROVIDER_PRESETS[provider];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md mx-4 p-8">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-gray-900">LLM 配置</h2>
          <p className="text-sm text-gray-400 mt-1">配置 AI 模型连接</p>
        </div>

        <div className="space-y-4">
          {/* Provider */}
          <div>
            <label className="text-xs font-medium text-gray-500 block mb-2">Provider</label>
            <div className="flex gap-2">
              {["anthropic", "openai", "custom"].map((p) => (
                <button
                  key={p}
                  onClick={() => handleProviderChange(p)}
                  className={`flex-1 rounded-xl py-2 text-xs font-medium transition-colors ${
                    provider === p
                      ? "bg-gray-900 text-white"
                      : "bg-gray-50 text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {p === "anthropic" ? "Anthropic" : p === "openai" ? "OpenAI" : "Custom"}
                </button>
              ))}
            </div>
          </div>

          {/* Model ID */}
          <div>
            <label className="text-xs font-medium text-gray-500 block mb-1.5">Model ID</label>
            <input
              type="text"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder={preset?.placeholder ?? "model-name"}
              className="w-full rounded-xl bg-gray-50 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none focus:ring-2 focus:ring-gray-200"
            />
          </div>

          {/* API Key */}
          <div>
            <label className="text-xs font-medium text-gray-500 block mb-1.5">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="w-full rounded-xl bg-gray-50 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none focus:ring-2 focus:ring-gray-200"
            />
          </div>

          {/* Base URL */}
          <div>
            <label className="text-xs font-medium text-gray-500 block mb-1.5">
              Base URL <span className="text-gray-300">(可选，OpenAI 兼容)</span>
            </label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={preset?.baseUrl || "https://your-endpoint/v1"}
              className="w-full rounded-xl bg-gray-50 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none focus:ring-2 focus:ring-gray-200"
            />
          </div>
        </div>

        <div className="flex gap-3 mt-8">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl border border-gray-200 text-gray-600 py-3 text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={!apiKey.trim() || !modelId.trim()}
            className="flex-1 rounded-xl bg-gray-900 text-white py-3 text-sm font-medium disabled:opacity-40 hover:bg-gray-700 transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
