"use client";

import { useState } from "react";
import type { LLMConfig, SavedModel } from "@/lib/types";

interface SettingsModalProps {
  config: LLMConfig | null;
  onSave: (config: LLMConfig) => void;
  onClose: () => void;
}

const PROVIDER_PRESETS: Record<string, { baseUrl: string; placeholder: string }> = {
  anthropic: { baseUrl: "https://api.anthropic.com", placeholder: "claude-sonnet-4-20250514" },
  google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", placeholder: "gemini-2.5-pro" },
  openai: { baseUrl: "https://api.openai.com", placeholder: "gpt-4o" },
  custom: { baseUrl: "", placeholder: "model-name" },
};

function loadSavedModels(): SavedModel[] {
  try {
    return JSON.parse(localStorage.getItem("me_saved_models") ?? "[]");
  } catch {
    return [];
  }
}

function persistSavedModels(models: SavedModel[]) {
  localStorage.setItem("me_saved_models", JSON.stringify(models));
}

export default function SettingsModal({ config, onSave, onClose }: SettingsModalProps) {
  const [savedModels, setSavedModels] = useState<SavedModel[]>(loadSavedModels);
  const [provider, setProvider] = useState(config?.provider ?? "anthropic");
  const [modelId, setModelId] = useState(config?.modelId ?? "");
  const [apiKey, setApiKey] = useState(config?.apiKey ?? "");
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? "");
  const [name, setName] = useState("");

  function handleProviderChange(p: string) {
    setProvider(p);
    if (p !== "custom") setBaseUrl(PROVIDER_PRESETS[p]?.baseUrl ?? "");
  }

  function handleUse(m: SavedModel) {
    onSave(m.config);
    onClose();
  }

  function handleDelete(id: string) {
    const updated = savedModels.filter((m) => m.id !== id);
    setSavedModels(updated);
    persistSavedModels(updated);
  }

  function handleSave() {
    if (!apiKey.trim() || !modelId.trim()) return;
    const cfg: LLMConfig = {
      provider,
      modelId: modelId.trim(),
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim() || undefined,
    };
    // 保存到列表
    if (name.trim()) {
      const existing = savedModels.find(
        (m) => m.config.provider === cfg.provider && m.config.modelId === cfg.modelId
      );
      if (!existing) {
        const updated = [
          ...savedModels,
          { id: `${Date.now()}`, name: name.trim(), config: cfg },
        ];
        setSavedModels(updated);
        persistSavedModels(updated);
      }
    }
    onSave(cfg);
    onClose();
  }

  const preset = PROVIDER_PRESETS[provider];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md mx-4 p-8 max-h-[90vh] overflow-y-auto">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-gray-900">LLM 配置</h2>
          <p className="text-sm text-gray-400 mt-1">配置 AI 模型连接</p>
        </div>

        {/* 已保存模型列表 */}
        {savedModels.length > 0 && (
          <div className="mb-6">
            <label className="text-xs font-medium text-gray-500 block mb-2">已保存模型</label>
            <div className="space-y-2">
              {savedModels.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-gray-800 truncate">{m.name}</div>
                    <div className="text-xs text-gray-400 truncate">{m.config.provider} · {m.config.modelId}</div>
                  </div>
                  <div className="flex gap-2 ml-3 shrink-0">
                    <button
                      onClick={() => handleUse(m)}
                      className="text-xs text-gray-900 font-medium hover:underline"
                    >
                      使用
                    </button>
                    <button
                      onClick={() => handleDelete(m.id)}
                      className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-gray-100 mt-4 pt-4">
              <label className="text-xs font-medium text-gray-500 block mb-1">或配置新模型</label>
            </div>
          </div>
        )}

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-gray-500 block mb-1.5">
              名称 <span className="text-gray-300">(填写后自动保存到列表)</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：Claude Sonnet 4"
              className="w-full rounded-xl bg-gray-50 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none focus:ring-2 focus:ring-gray-200"
            />
          </div>

          {/* Provider */}
          <div>
            <label className="text-xs font-medium text-gray-500 block mb-2">Provider</label>
            <div className="flex gap-2">
              {["anthropic", "google", "openai", "custom"].map((p) => (
                <button
                  key={p}
                  onClick={() => handleProviderChange(p)}
                  className={`flex-1 rounded-xl py-2 text-xs font-medium transition-colors ${
                    provider === p
                      ? "bg-gray-900 text-white"
                      : "bg-gray-50 text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {p === "anthropic" ? "Anthropic" : p === "google" ? "Google" : p === "openai" ? "OpenAI" : "Custom"}
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
              Base URL <span className="text-gray-300">(可选，覆盖默认网关)</span>
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
            保存并使用
          </button>
        </div>
      </div>
    </div>
  );
}
