"use client";

import { useEffect, useMemo, useState } from "react";
import type { Asset, Clip, Project, ProjectDetail } from "@/lib/types";
import {
  createUserProject,
  deleteUserProject,
  updateUserProject,
  exportProject,
  getProjectDownloadUrl,
  listUserProjects,
  loadProject,
  saveProjectClips,
} from "@/lib/api";

interface TimelinePanelProps {
  username: string;
  onClose?: () => void;
  refreshTick?: number;
  incomingAsset?: Asset | null;
  onIncomingAssetConsumed?: () => void;
  embedded?: boolean;
  onOpenAssetLibrary?: () => void;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export default function TimelinePanel({
  username,
  onClose,
  refreshTick,
  incomingAsset,
  onIncomingAssetConsumed,
  embedded = false,
  onOpenAssetLibrary,
}: TimelinePanelProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<ProjectDetail | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editProjectName, setEditProjectName] = useState("");

  async function refreshProjects(selectProjectId?: string) {
    const list = await listUserProjects(username);
    setProjects(list);

    const preferredId = selectProjectId ?? activeProjectId;
    const targetId = preferredId && list.some((p) => p.projectId === preferredId)
      ? preferredId
      : list[0]?.projectId ?? null;
    setActiveProjectId(targetId);
    if (targetId) {
      const detail = await loadProject(username, targetId);
      if (detail) {
        setActiveProject(detail);
      } else {
        setActiveProjectId(null);
        setActiveProject(null);
      }
    } else {
      setActiveProject(null);
    }
  }

  useEffect(() => {
    setLoading(true);
    refreshProjects().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, refreshTick]);

  const totalDuration = useMemo(() => {
    if (!activeProject?.clips?.length) return 0;
    return activeProject.clips.reduce((sum, c) => {
      const end = c.trimEnd > 0 ? c.trimEnd : (c.assetDuration ?? 0);
      return sum + Math.max(0, end - c.trimStart);
    }, 0);
  }, [activeProject]);

  async function handleCreateProject() {
    const name = newProjectName.trim() || `短片 ${new Date().toLocaleDateString("zh-CN")}`;
    const p = await createUserProject(username, name);
    setNewProjectName("");
    await refreshProjects(p.projectId);
  }

  async function selectProject(projectId: string) {
    setActiveProjectId(projectId);
    const detail = await loadProject(username, projectId);
    if (!detail) {
      await refreshProjects();
      return;
    }
    setActiveProject(detail);
  }

  async function handleDeleteProject(projectId: string) {
    if (!confirm("确定删除此短片项目？所有片段数据将丢失。")) return;
    await deleteUserProject(username, projectId);
    if (activeProjectId === projectId) {
      setActiveProjectId(null);
      setActiveProject(null);
    }
    await refreshProjects();
  }

  async function handleRenameProject(projectId: string) {
    const name = editProjectName.trim();
    if (!name) { setEditingProjectId(null); return; }
    await updateUserProject(username, projectId, { name } as any);
    setEditingProjectId(null);
    setProjects((prev) => prev.map((p) => p.projectId === projectId ? { ...p, name } : p));
    if (activeProject?.projectId === projectId) {
      setActiveProject((prev) => prev ? { ...prev, name } : prev);
    }
  }

  async function persistClips(clips: Clip[]) {
    if (!activeProjectId) return;
    setSaving(true);
    try {
      const saved = await saveProjectClips(
        username,
        activeProjectId,
        clips.map((c, idx) => ({
          clipId: c.clipId,
          assetId: c.assetId,
          position: idx,
          trimStart: c.trimStart,
          trimEnd: c.trimEnd,
        }))
      );
      setActiveProject((prev) => prev ? { ...prev, clips: saved } : prev);
      await refreshProjects(activeProjectId);
    } finally {
      setSaving(false);
    }
  }

  async function ensureProjectForIncomingAsset(): Promise<string> {
    if (activeProjectId) return activeProjectId;
    const p = await createUserProject(username, `短片 ${new Date().toLocaleDateString("zh-CN")}`);
    await refreshProjects(p.projectId);
    return p.projectId;
  }

  async function appendAssetAsClip(asset: Asset) {
    const projectId = await ensureProjectForIncomingAsset();
    let project = activeProject;
    if (!project || project.projectId !== projectId) {
      project = await loadProject(username, projectId);
      setActiveProject(project);
      setActiveProjectId(projectId);
    }
    const clips = [...(project?.clips ?? [])];
    clips.push({
      clipId: generateId(),
      projectId,
      assetId: asset.assetId,
      position: clips.length,
      trimStart: 0,
      trimEnd: asset.duration,
      assetName: asset.name,
      assetDuration: asset.duration,
      filePath: asset.filePath,
      createdAt: Date.now(),
    });
    await persistClips(clips);
  }

  useEffect(() => {
    if (!incomingAsset) return;
    appendAssetAsClip(incomingAsset).finally(() => {
      onIncomingAssetConsumed?.();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingAsset?.assetId]);

  async function handleMove(index: number, dir: -1 | 1) {
    if (!activeProject) return;
    const nextIndex = index + dir;
    if (nextIndex < 0 || nextIndex >= activeProject.clips.length) return;
    const next = [...activeProject.clips];
    const tmp = next[index];
    next[index] = next[nextIndex];
    next[nextIndex] = tmp;
    setActiveProject({ ...activeProject, clips: next });
    await persistClips(next);
  }

  async function handleDeleteClip(clipId: string) {
    if (!activeProject) return;
    const next = activeProject.clips.filter((c) => c.clipId !== clipId);
    setActiveProject({ ...activeProject, clips: next });
    await persistClips(next);
  }

  function patchClipLocal(clipId: string, patch: Partial<Clip>) {
    if (!activeProject) return;
    setActiveProject({
      ...activeProject,
      clips: activeProject.clips.map((c) => (c.clipId === clipId ? { ...c, ...patch } : c)),
    });
  }

  async function commitClip(clipId: string) {
    if (!activeProject) return;
    const clip = activeProject.clips.find((c) => c.clipId === clipId);
    if (!clip) return;
    const maxEnd = clip.assetDuration ?? clip.trimEnd;
    const trimStart = Math.max(0, Math.min(clip.trimStart, maxEnd));
    const trimEnd = Math.max(trimStart, Math.min(clip.trimEnd, maxEnd));
    const next = activeProject.clips.map((c) => c.clipId === clipId ? { ...c, trimStart, trimEnd } : c);
    setActiveProject({ ...activeProject, clips: next });
    await persistClips(next);
  }

  async function handleExport() {
    if (!activeProjectId) return;
    setExporting(true);
    await exportProject(username, activeProjectId);

    let done = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const detail = await loadProject(username, activeProjectId);
      if (!detail) continue;
      setActiveProject(detail);
      setProjects((prev) => prev.map((p) => p.projectId === detail.projectId ? detail : p));
      if (detail.status === "done" || detail.status === "error") {
        done = true;
        break;
      }
    }
    if (!done) {
      const detail = await loadProject(username, activeProjectId);
      if (detail) setActiveProject(detail);
    }
    setExporting(false);
  }

  return (
    <div className={embedded ? "h-full w-full flex flex-col bg-white rounded-2xl border border-gray-100 overflow-hidden" : "fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"}>
      <div className={embedded ? "h-full w-full flex flex-col overflow-hidden" : "bg-white rounded-2xl shadow-2xl w-[1100px] max-h-[82vh] flex flex-col overflow-hidden"}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">时间线</h2>
            <p className="text-xs text-gray-400 mt-0.5">新建短片项目、拼接素材并支持截取</p>
          </div>
          <div className="flex items-center gap-2">
            {embedded && (
              <button
                onClick={onOpenAssetLibrary}
                className="rounded-xl bg-gray-900 text-white px-3 py-1.5 text-xs font-medium hover:bg-gray-700 transition-colors"
              >
                + 素材
              </button>
            )}
            {!embedded && onClose && (
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg transition-colors">✕</button>
            )}
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div className="w-[280px] border-r border-gray-100 p-4 flex flex-col gap-3">
            <div className="space-y-2">
              <input
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="新短片名称"
                className="w-full rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-gray-200"
              />
              <button
                onClick={handleCreateProject}
                className="w-full rounded-xl bg-gray-900 text-white py-2 text-xs font-medium hover:bg-gray-700 transition-colors"
              >
                + 新建短片项目
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2">
              {loading ? (
                <p className="text-xs text-gray-400">加载中...</p>
              ) : projects.length === 0 ? (
                <p className="text-xs text-gray-400">还没有短片项目</p>
              ) : (
                projects.map((p) => (
                  <div
                    key={p.projectId}
                    className={`group relative rounded-xl px-3 py-2 border transition-colors cursor-pointer ${
                      p.projectId === activeProjectId
                        ? "border-gray-900 bg-gray-50"
                        : "border-gray-100 hover:border-gray-200"
                    }`}
                    onClick={() => selectProject(p.projectId)}
                  >
                    {editingProjectId === p.projectId ? (
                      <input
                        value={editProjectName}
                        onChange={(e) => setEditProjectName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleRenameProject(p.projectId); if (e.key === "Escape") setEditingProjectId(null); }}
                        onBlur={() => handleRenameProject(p.projectId)}
                        autoFocus
                        className="text-xs font-medium text-gray-900 w-full bg-gray-100 rounded px-1.5 py-0.5 outline-none"
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <p
                        className="text-xs font-medium text-gray-900 truncate"
                        onDoubleClick={(e) => { e.stopPropagation(); setEditingProjectId(p.projectId); setEditProjectName(p.name); }}
                      >
                        {p.name}
                      </p>
                    )}
                    <p className="text-[11px] text-gray-400 mt-0.5">状态：{p.status}</p>
                    <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteProject(p.projectId); }}
                        className="text-[10px] text-red-400 hover:text-red-600"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="flex-1 p-4 overflow-y-auto">
            {!activeProject ? (
              <div className="h-full flex items-center justify-center text-sm text-gray-400">
                先创建或选择一个短片项目
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl border border-gray-100 p-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{activeProject.name}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      共 {activeProject.clips.length} 段 · 总时长 {formatDuration(totalDuration)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleExport}
                      disabled={activeProject.clips.length === 0 || exporting}
                      className="rounded-xl bg-gray-900 text-white px-4 py-2 text-xs font-medium disabled:opacity-40 hover:bg-gray-700 transition-colors"
                    >
                      {exporting ? "导出中..." : "导出短片"}
                    </button>
                    {activeProject.status === "done" && (
                      <a
                        href={getProjectDownloadUrl(username, activeProject.projectId)}
                        className="rounded-xl border border-gray-200 text-gray-700 px-4 py-2 text-xs font-medium hover:bg-gray-50 transition-colors"
                      >
                        下载
                      </a>
                    )}
                  </div>
                </div>

                {activeProject.clips.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center text-sm text-gray-400">
                    当前时间线为空。先在“素材库”里把视频添加到时间线。
                  </div>
                ) : (
                  <div className="space-y-2">
                    {activeProject.clips.map((clip, idx) => (
                      <div key={clip.clipId} className="rounded-xl border border-gray-100 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-gray-900 truncate">
                              {idx + 1}. {clip.assetName || "未命名素材"}
                            </p>
                            <p className="text-[11px] text-gray-400 mt-0.5">
                              原始时长 {formatDuration(clip.assetDuration ?? 0)}
                            </p>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleMove(idx, -1)}
                              disabled={idx === 0 || saving}
                              className="rounded-lg border border-gray-200 px-2 py-1 text-[11px] text-gray-700 disabled:opacity-40"
                            >
                              上移
                            </button>
                            <button
                              onClick={() => handleMove(idx, 1)}
                              disabled={idx === activeProject.clips.length - 1 || saving}
                              className="rounded-lg border border-gray-200 px-2 py-1 text-[11px] text-gray-700 disabled:opacity-40"
                            >
                              下移
                            </button>
                            <button
                              onClick={() => handleDeleteClip(clip.clipId)}
                              disabled={saving}
                              className="rounded-lg border border-red-200 px-2 py-1 text-[11px] text-red-500 disabled:opacity-40"
                            >
                              删除
                            </button>
                          </div>
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-3">
                          <label className="block">
                            <span className="text-[11px] text-gray-400">截取开始（秒）</span>
                            <input
                              type="number"
                              min={0}
                              max={clip.assetDuration ?? 0}
                              step={0.1}
                              value={clip.trimStart}
                              onChange={(e) => patchClipLocal(clip.clipId, { trimStart: Number(e.target.value) })}
                              onBlur={() => commitClip(clip.clipId)}
                              className="mt-1 w-full rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-gray-200"
                            />
                          </label>
                          <label className="block">
                            <span className="text-[11px] text-gray-400">截取结束（秒）</span>
                            <input
                              type="number"
                              min={0}
                              max={clip.assetDuration ?? 0}
                              step={0.1}
                              value={clip.trimEnd}
                              onChange={(e) => patchClipLocal(clip.clipId, { trimEnd: Number(e.target.value) })}
                              onBlur={() => commitClip(clip.clipId)}
                              className="mt-1 w-full rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-gray-200"
                            />
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
