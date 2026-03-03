"use client";

import dynamic from "next/dynamic";
import { useRef, useEffect, useState } from "react";
import { getVideoUrl } from "@/lib/api";
import type { LogEntryKind, RenderParams } from "@/lib/types";

const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

type Tab = "code" | "preview" | "video";

interface CodePreviewPanelProps {
  value: string;
  onChange: (value: string) => void;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  videoUrl: string | null;
  renderParams: RenderParams;
  library: string;
  onPreviewLog: (kind: LogEntryKind, label: string, detail?: string) => void;
}

const DEBUG_BRIDGE = `<script>
window.__previewEmit = function(type, payload) {
  try {
    parent.postMessage({ source: "magiceffect-preview", type, payload }, "*");
  } catch {}
};
window.addEventListener("error", function(e) {
  window.__previewEmit("runtime_error", {
    message: e.message,
    filename: e.filename,
    lineno: e.lineno,
    colno: e.colno,
    stack: e.error && e.error.stack ? e.error.stack : ""
  });
});
window.addEventListener("unhandledrejection", function(e) {
  var reason = e.reason;
  window.__previewEmit("unhandled_rejection", {
    message: typeof reason === "string" ? reason : (reason && reason.message ? reason.message : "unhandled rejection")
  });
});
</script>`;

function scriptWithProbe(src: string, name: string): string {
  return `<script src="${src}" onload="window.__previewEmit && window.__previewEmit('script_loaded', { name: '${name}', src: this.src })" onerror="window.__previewEmit && window.__previewEmit('script_error', { name: '${name}', src: this.src })"></script>`;
}

const GSAP_CDN = scriptWithProbe("https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js", "gsap");
const ANIME_CDN = scriptWithProbe("https://cdnjs.cloudflare.com/ajax/libs/animejs/3.2.2/anime.min.js", "anime");
const PIXI_CDN = `${GSAP_CDN}${scriptWithProbe("https://cdn.jsdelivr.net/npm/pixi.js@7.4.2/dist/pixi.min.js", "pixi")}`;
const THREE_CDN = (origin: string) => `${GSAP_CDN}${scriptWithProbe(`${origin}/libs/three.min.js`, "three_local")}${scriptWithProbe("https://unpkg.com/three@0.160.0/build/three.min.js", "three_cdn")}`;
const ECHARTS_CDN = `${GSAP_CDN}${scriptWithProbe("https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js", "echarts")}`;

function buildPreviewHtml(code: string, library: string, width: number, height: number): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const inferredLibrary = code.includes("THREE") ? "three"
    : (code.includes("echarts") || code.includes("echarts.init")) ? "echarts"
    : code.includes("PIXI") ? "pixi"
    : (code.includes("anime(") || code.includes("anime.")) ? "anime"
    : library;

  const libScript = inferredLibrary === "anime" ? ANIME_CDN
    : inferredLibrary === "pixi" ? PIXI_CDN
    : inferredLibrary === "three" ? THREE_CDN(origin)
    : inferredLibrary === "echarts" ? ECHARTS_CDN
    : GSAP_CDN;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>* { margin:0; padding:0; box-sizing:border-box; } html,body { width:100vw; height:100vh; overflow:hidden; background:#000; }</style>
${DEBUG_BRIDGE}
${libScript}
</head><body>
<script>
window.CANVAS_WIDTH = ${width};
window.CANVAS_HEIGHT = ${height};
window.SCALE = Math.min(${width} / 1280, ${height} / 720);
window.__previewEmit("preview_boot", {
  library: ${JSON.stringify(inferredLibrary)},
  width: ${width},
  height: ${height},
  origin: ${JSON.stringify(origin)}
});
${code}
if (${JSON.stringify(inferredLibrary)} === "three") {
  setTimeout(function() {
    if (!window.THREE) {
      window.__previewEmit("three_missing", { message: "THREE is still undefined after script load." });
    }
  }, 0);
}
</script>
</body></html>`;
}

export default function CodePreviewPanel({
  value, onChange, tab, onTabChange, videoUrl, renderParams, library, onPreviewLog,
}: CodePreviewPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [timerRunning, setTimerRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [loopMarks, setLoopMarks] = useState<number[]>([]);
  const timerStartRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
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

  useEffect(() => {
    if (!timerRunning) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    const tick = () => {
      if (timerStartRef.current) {
        setElapsedMs(Date.now() - timerStartRef.current);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [timerRunning]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || data.source !== "magiceffect-preview") return;

      const payload = data.payload ? JSON.stringify(data.payload) : undefined;
      if (data.type === "script_error") {
        onPreviewLog("error", `preview script load failed: ${data.payload?.name ?? "unknown"}`, payload);
        return;
      }
      if (data.type === "runtime_error" || data.type === "unhandled_rejection" || data.type === "three_missing") {
        onPreviewLog("error", `preview runtime error: ${data.payload?.message ?? data.type}`, payload);
        return;
      }
      if (data.type === "script_loaded") {
        onPreviewLog("info", `preview script loaded: ${data.payload?.name ?? "unknown"}`, payload);
        return;
      }
      if (data.type === "preview_boot") {
        onPreviewLog("info", `preview boot (${data.payload?.library ?? "unknown"})`, payload);
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onPreviewLog]);

  const previewHtml = tab === "preview"
    ? buildPreviewHtml(value, library, width, height)
    : "";

  function fmt(ms: number): string {
    return (ms / 1000).toFixed(2);
  }

  function handleTimerStartPause() {
    if (!timerRunning) {
      timerStartRef.current = Date.now() - elapsedMs;
      setTimerRunning(true);
      return;
    }
    setTimerRunning(false);
  }

  function handleLoopMark() {
    if (!timerRunning) return;
    setLoopMarks((prev) => [...prev, elapsedMs]);
  }

  function handleTimerReset() {
    setTimerRunning(false);
    timerStartRef.current = null;
    setElapsedMs(0);
    setLoopMarks([]);
  }

  const loopIntervals = loopMarks.slice(1).map((m, i) => m - loopMarks[i]);
  const avgLoopMs = loopIntervals.length
    ? Math.round(loopIntervals.reduce((a, b) => a + b, 0) / loopIntervals.length)
    : null;

  return (
    <div className="h-full w-full rounded-2xl overflow-hidden border border-gray-100 flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 bg-white border-b border-gray-100 shrink-0 gap-3">
        <div className="min-w-0 flex-1 flex items-center gap-2 text-xs">
          {tab === "preview" ? (
            <>
              <button
                onClick={handleTimerStartPause}
                className="rounded-full px-3 py-1 bg-gray-900 text-white"
              >
                {timerRunning ? "暂停" : "开始"}
              </button>
              <button
                onClick={handleLoopMark}
                disabled={!timerRunning}
                className="rounded-full px-3 py-1 border border-gray-300 disabled:opacity-40"
              >
                打点
              </button>
              <button
                onClick={handleTimerReset}
                className="rounded-full px-3 py-1 border border-gray-300"
              >
                重置
              </button>
              <span className="text-gray-600 whitespace-nowrap">计时: {fmt(elapsedMs)}s</span>
              <span className="text-gray-500 whitespace-nowrap">打点: {loopMarks.length}</span>
              {avgLoopMs !== null && (
                <span className="text-gray-900 font-medium whitespace-nowrap">平均 Loop: {fmt(avgLoopMs)}s</span>
              )}
            </>
          ) : (
            <span className="text-gray-400">预览页可用计时与打点</span>
          )}
        </div>

        <div className="flex bg-gray-100 rounded-full p-0.5 gap-0.5 shrink-0">
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
          {videoUrl && (
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
          <div className="h-full w-full bg-black flex overflow-hidden">
            <div ref={containerRef} className="flex-1 w-full flex items-center justify-center overflow-hidden">
              <div style={{ width, height, transform: `scale(${scale})`, transformOrigin: "center center", flexShrink: 0 }}>
                <iframe
                  key={previewHtml}
                  srcDoc={previewHtml}
                  sandbox="allow-scripts"
                  style={{ width, height, border: "none", display: "block" }}
                />
              </div>
            </div>
          </div>
        )}

        {tab === "video" && videoUrl && (
          <div className="h-full flex flex-col items-center justify-center bg-black gap-4">
            <video
              key={videoUrl}
              src={videoUrl}
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
