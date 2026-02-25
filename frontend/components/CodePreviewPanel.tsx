"use client";

import dynamic from "next/dynamic";
import { useRef, useEffect, useState } from "react";
import { getDownloadUrl } from "@/lib/api";
import type { RenderParams } from "@/lib/types";

const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

type Tab = "code" | "preview" | "video";

interface CodePreviewPanelProps {
  value: string;
  onChange: (value: string) => void;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  doneJobId: string | null;
  renderParams: RenderParams;
  library: string;
}

const GSAP_CDN = `<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>`;
const ANIME_CDN = `<script src="https://cdnjs.cloudflare.com/ajax/libs/animejs/3.2.2/anime.min.js"></script>`;
const PIXI_CDN = `${GSAP_CDN}<script src="https://cdn.jsdelivr.net/npm/pixi.js@7.4.2/dist/pixi.min.js"></script>`;
const THREE_CDN = `${GSAP_CDN}<script src="https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.min.js"></script>`;

function buildPreviewHtml(code: string, library: string, width: number, height: number): string {
  const libScript = library === "anime" ? ANIME_CDN
    : library === "pixi" ? PIXI_CDN
    : library === "three" ? THREE_CDN
    : GSAP_CDN;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>* { margin:0; padding:0; box-sizing:border-box; } html,body { width:100vw; height:100vh; overflow:hidden; background:#000; }</style>
${libScript}
</head><body>
<script>
window.CANVAS_WIDTH = ${width};
window.CANVAS_HEIGHT = ${height};
${code}
</script>
</body></html>`;
}

export default function CodePreviewPanel({
  value, onChange, tab, onTabChange, doneJobId, renderParams, library,
}: CodePreviewPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const { width, height } = renderParams;

  useEffect(() => {
    if (tab !== "preview") return;
    function updateScale() {
      if (!containerRef.current) return;
      const cw = containerRef.current.clientWidth;
      const ch = containerRef.current.clientHeight;
      setScale(Math.min(cw / width, ch / height));
    }
    updateScale();
    const ro = new ResizeObserver(updateScale);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [tab, width, height]);

  const previewHtml = tab === "preview"
    ? buildPreviewHtml(value, library, width, height)
    : "";

  return (
    <div className="h-full w-full rounded-2xl overflow-hidden border border-gray-100 flex flex-col">
      <div className="flex items-center justify-center py-2.5 bg-white border-b border-gray-100 shrink-0">
        <div className="flex bg-gray-100 rounded-full p-0.5 gap-0.5">
          <button
            onClick={() => onTabChange("code")}
            className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${tab === "code" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
          >
            代码
          </button>
          <button
            onClick={() => onTabChange("preview")}
            className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${tab === "preview" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
          >
            预览
          </button>
          {doneJobId && (
            <button
              onClick={() => onTabChange("video")}
              className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${tab === "video" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
            >
              视频
            </button>
          )}
        </div>
      </div>

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

        {tab === "preview" && (
          <div ref={containerRef} className="h-full w-full bg-black flex items-center justify-center overflow-hidden">
            <div style={{ width, height, transform: `scale(${scale})`, transformOrigin: "center center", flexShrink: 0 }}>
              <iframe
                key={previewHtml}
                srcDoc={previewHtml}
                sandbox="allow-scripts"
                style={{ width, height, border: "none", display: "block" }}
              />
            </div>
          </div>
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
