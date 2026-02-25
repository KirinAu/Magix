"use client";

import dynamic from "next/dynamic";
import { getDownloadUrl } from "@/lib/api";

const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

type Tab = "code" | "video";

interface CodePreviewPanelProps {
  value: string;
  onChange: (value: string) => void;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  doneJobId: string | null;
}

export default function CodePreviewPanel({
  value,
  onChange,
  tab,
  onTabChange,
  doneJobId,
}: CodePreviewPanelProps) {
  return (
    <div className="h-full w-full rounded-2xl overflow-hidden border border-gray-100 flex flex-col">
      {/* 胶囊切换 */}
      <div className="flex items-center justify-center py-2.5 bg-white border-b border-gray-100 shrink-0">
        <div className="flex bg-gray-100 rounded-full p-0.5 gap-0.5">
          <button
            onClick={() => onTabChange("code")}
            className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${
              tab === "code" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            代码
          </button>
          {doneJobId && (
            <button
              onClick={() => onTabChange("video")}
              className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${
                tab === "video" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              视频预览
            </button>
          )}
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0">
        {tab === "code" && (
          <Editor
            height="100%"
            defaultLanguage="javascript"
            value={value}
            theme="vs-dark"
            onChange={(v: string | undefined) => onChange(v ?? "")}
            options={{
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineNumbers: "on",
              wordWrap: "on",
              tabSize: 2,
              automaticLayout: true,
              padding: { top: 16, bottom: 16 },
            }}
          />
        )}

        {tab === "video" && doneJobId && (
          <div className="h-full flex flex-col items-center justify-center bg-black gap-4">
            <video
              key={doneJobId}
              src={getDownloadUrl(doneJobId)}
              controls
              autoPlay
              loop
              className="max-h-full max-w-full"
            />
          </div>
        )}
      </div>
    </div>
  );
}
