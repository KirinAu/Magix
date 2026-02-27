"use client";

import { useState, useEffect } from "react";
import type { RenderParams, RenderJob } from "@/lib/types";
import { submitRender, watchRenderJob, getDownloadUrl } from "@/lib/api";

interface RenderPanelProps {
  code: string;
  library: string;
  params: RenderParams;
  onParamsChange: (params: RenderParams) => void;
  onRenderDone?: (jobId: string, outputFile: string) => void;
  username?: string;
  sessionId?: string;
  initialJob?: RenderJob | null;
}

const PRESETS = [
  { label: "720p 30fps",  width: 1280, height: 720,  fps: 30 },
  { label: "1080p 30fps", width: 1920, height: 1080, fps: 30 },
  { label: "1080p 60fps", width: 1920, height: 1080, fps: 60 },
  { label: "4K 60fps",    width: 3840, height: 2160, fps: 60 },
  { label: "Square 1:1", width: 1080, height: 1080, fps: 30 },
];

export default function RenderPanel({ code, library, params, onParamsChange, onRenderDone, username, sessionId, initialJob }: RenderPanelProps) {
  const [job, setJob] = useState<RenderJob | null>(initialJob ?? null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 切换会话时恢复 job，如果还在跑就重连 SSE
  useEffect(() => {
    setJob(initialJob ?? null);
    if (initialJob && (initialJob.status === "pending" || initialJob.status === "rendering" || initialJob.status === "encoding")) {
      watchRenderJob(initialJob.jobId, (update) => {
        setJob({ jobId: initialJob.jobId, ...update });
        if (update.status === "done") onRenderDone?.(initialJob.jobId, update.outputFile ?? "");
      });
    }
  }, [initialJob?.jobId]);

  async function handleRender() {
    if (!code.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setJob(null);

    try {
      const jobId = await submitRender({ code, library, ...params, username, sessionId });
      const initialJob: RenderJob = { jobId, status: "pending", progress: 0, total: 0 };
      setJob(initialJob);

      watchRenderJob(jobId, (update) => {
        setJob({ jobId, ...update });
        if (update.status === "done") onRenderDone?.(jobId, update.outputFile ?? "");
      });
    } catch (err: any) {
      setJob({ jobId: "", status: "error", progress: 0, total: 0, error: err.message });
    } finally {
      setIsSubmitting(false);
    }
  }

  const progressPct = job && job.total > 0
    ? Math.round((job.progress / job.total) * 100)
    : 0;

  const statusLabel: Record<string, string> = {
    pending: "等待中...",
    rendering: `渲染帧 ${job?.progress ?? 0} / ${job?.total ?? 0}`,
    encoding: "编码 MP4...",
    done: "完成",
    error: "出错了",
  };

  return (
    <div className="flex flex-col h-full bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100">
        <p className="text-sm font-semibold text-gray-900">渲染设置</p>
        <p className="text-xs text-gray-400 mt-0.5">配置输出参数</p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* 预设 */}
        <div>
          <p className="text-xs font-medium text-gray-500 mb-2">预设</p>
          <div className="grid grid-cols-2 gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => onParamsChange({ ...params, width: p.width, height: p.height, fps: p.fps })}
                className={`rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
                  params.width === p.width && params.height === p.height && params.fps === p.fps
                    ? "bg-gray-900 text-white"
                    : "bg-gray-50 text-gray-700 hover:bg-gray-100"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 自定义参数 */}
        <div className="space-y-3">
          <p className="text-xs font-medium text-gray-500">自定义</p>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-gray-400">宽度 px</span>
              <input
                type="number"
                value={params.width}
                onChange={(e) => onParamsChange({ ...params, width: Number(e.target.value) })}
                className="mt-1 w-full rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-gray-200"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-400">高度 px</span>
              <input
                type="number"
                value={params.height}
                onChange={(e) => onParamsChange({ ...params, height: Number(e.target.value) })}
                className="mt-1 w-full rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-gray-200"
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-gray-400">帧率 fps</span>
              <input
                type="number"
                value={params.fps}
                min={1}
                max={120}
                onChange={(e) => onParamsChange({ ...params, fps: Number(e.target.value) })}
                className="mt-1 w-full rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-gray-200"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-400">时长 秒</span>
              <input
                type="number"
                value={params.duration}
                min={0.1}
                step={0.5}
                onChange={(e) => onParamsChange({ ...params, duration: Number(e.target.value) })}
                className="mt-1 w-full rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-gray-200"
              />
            </label>
          </div>
        </div>

        {/* 总帧数预览 */}
        <div className="rounded-xl bg-gray-50 px-4 py-3">
          <p className="text-xs text-gray-400">
            总帧数：<span className="text-gray-700 font-medium">{Math.ceil(params.fps * params.duration)}</span> 帧
            &nbsp;·&nbsp;
            库：<span className="text-gray-700 font-medium">{library || "auto"}</span>
          </p>
        </div>

        {/* 进度 */}
        {job && (
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <p className="text-xs text-gray-500">{statusLabel[job.status] ?? job.status}</p>
              {job.status === "rendering" && (
                <p className="text-xs font-medium text-gray-700">{progressPct}%</p>
              )}
            </div>

            {(job.status === "rendering" || job.status === "encoding") && (
              <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gray-900 rounded-full transition-all duration-300"
                  style={{ width: job.status === "encoding" ? "100%" : `${progressPct}%` }}
                />
              </div>
            )}

            {job.status === "error" && (
              <p className="text-xs text-red-500 bg-red-50 rounded-xl px-3 py-2">{job.error}</p>
            )}
          </div>
        )}
      </div>

      {/* 底部按钮 */}
      <div className="px-5 py-4 border-t border-gray-100 space-y-2">
        <button
          onClick={handleRender}
          disabled={!code.trim() || isSubmitting || job?.status === "rendering" || job?.status === "encoding"}
          className="w-full rounded-xl bg-gray-900 text-white py-3 text-sm font-medium disabled:opacity-40 hover:bg-gray-700 transition-colors"
        >
          {isSubmitting || job?.status === "rendering" || job?.status === "encoding"
            ? "渲染中..."
            : "开始渲染"}
        </button>

        {job?.status === "done" && job.jobId && (
          <a
            href={getDownloadUrl(job.jobId)}
            download="animation.mp4"
            className="block w-full rounded-xl border border-gray-200 text-gray-700 py-3 text-sm font-medium text-center hover:bg-gray-50 transition-colors"
          >
            下载 MP4
          </a>
        )}
      </div>
    </div>
  );
}
