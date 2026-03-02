"use client";

import { useState, useEffect, useRef } from "react";
import type { Asset } from "@/lib/types";
import { listUserAssets, deleteUserAsset, renameUserAsset, getAssetStreamUrl } from "@/lib/api";

interface AssetLibraryProps {
  username: string;
  onClose: () => void;
  onSelectAsset?: (asset: Asset) => void;
  onAssetDeleted?: () => void;
  refreshTick?: number;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function AssetLibrary({ username, onClose, onSelectAsset, onAssetDeleted, refreshTick }: AssetLibraryProps) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);

  async function load() {
    setLoading(true);
    const list = await listUserAssets(username);
    setAssets(list);
    setLoading(false);
  }

  useEffect(() => { load(); }, [username, refreshTick]);

  async function handleDelete(assetId: string) {
    if (!confirm("确定删除这个素材？引用了该素材的时间线片段也会被删除。")) return;
    await deleteUserAsset(username, assetId);
    setAssets((prev) => prev.filter((a) => a.assetId !== assetId));
    if (previewAsset?.assetId === assetId) setPreviewAsset(null);
    onAssetDeleted?.();
  }

  async function handleRename(assetId: string) {
    if (!editName.trim()) return;
    await renameUserAsset(username, assetId, editName.trim());
    setAssets((prev) => prev.map((a) => a.assetId === assetId ? { ...a, name: editName.trim() } : a));
    setEditingId(null);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-[900px] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">素材库</h2>
            <p className="text-xs text-gray-400 mt-0.5">管理已渲染的视频素材</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg transition-colors">✕</button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* 素材列表 */}
          <div className="flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="flex items-center justify-center h-40 text-sm text-gray-400">加载中...</div>
            ) : assets.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-sm text-gray-400">
                <p>暂无素材</p>
                <p className="text-xs mt-1">渲染完成后会自动加入素材库</p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {assets.map((asset) => (
                  <div
                    key={asset.assetId}
                    className={`group relative rounded-xl border p-3 cursor-pointer transition-all hover:shadow-md ${
                      previewAsset?.assetId === asset.assetId
                        ? "border-gray-900 bg-gray-50"
                        : "border-gray-100 hover:border-gray-200"
                    }`}
                    onClick={() => setPreviewAsset(asset)}
                  >
                    {/* 缩略图区域 */}
                    <div className="w-full aspect-video bg-gray-900 rounded-lg overflow-hidden mb-2 flex items-center justify-center">
                      <video
                        src={getAssetStreamUrl(asset.assetId)}
                        className="w-full h-full object-cover"
                        muted
                        preload="metadata"
                        onMouseEnter={(e) => (e.target as HTMLVideoElement).play().catch(() => {})}
                        onMouseLeave={(e) => { const v = e.target as HTMLVideoElement; v.pause(); v.currentTime = 0; }}
                      />
                    </div>

                    {/* 信息 */}
                    <div className="space-y-1">
                      {editingId === asset.assetId ? (
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleRename(asset.assetId); if (e.key === "Escape") setEditingId(null); }}
                          onBlur={() => handleRename(asset.assetId)}
                          autoFocus
                          className="text-xs font-medium text-gray-900 w-full bg-gray-100 rounded px-1.5 py-0.5 outline-none"
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <p
                          className="text-xs font-medium text-gray-900 truncate"
                          onDoubleClick={(e) => { e.stopPropagation(); setEditingId(asset.assetId); setEditName(asset.name); }}
                        >
                          {asset.name}
                        </p>
                      )}
                      <div className="flex items-center gap-2 text-[10px] text-gray-400">
                        <span>{asset.width}×{asset.height}</span>
                        <span>{asset.fps}fps</span>
                        <span>{formatDuration(asset.duration)}</span>
                      </div>
                    </div>

                    {/* 操作按钮 */}
                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity">
                      {onSelectAsset && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onSelectAsset(asset); }}
                          className="bg-gray-900 text-white text-[10px] rounded-lg px-2 py-1 hover:bg-gray-700"
                        >
                          添加到时间线
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(asset.assetId); }}
                        className="bg-red-500 text-white text-[10px] rounded-lg px-2 py-1 hover:bg-red-400"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 预览面板 */}
          {previewAsset && (
            <div className="w-[320px] border-l border-gray-100 p-4 flex flex-col">
              <div className="w-full aspect-video bg-black rounded-lg overflow-hidden mb-3">
                <video
                  ref={videoRef}
                  src={getAssetStreamUrl(previewAsset.assetId)}
                  className="w-full h-full object-contain"
                  controls
                  autoPlay
                />
              </div>
              <div className="space-y-2 text-xs text-gray-600">
                <p className="font-medium text-gray-900 text-sm">{previewAsset.name}</p>
                <div className="grid grid-cols-2 gap-y-1 text-[11px]">
                  <span className="text-gray-400">分辨率</span>
                  <span>{previewAsset.width}×{previewAsset.height}</span>
                  <span className="text-gray-400">帧率</span>
                  <span>{previewAsset.fps} fps</span>
                  <span className="text-gray-400">时长</span>
                  <span>{formatDuration(previewAsset.duration)}</span>
                  <span className="text-gray-400">创建时间</span>
                  <span>{new Date(previewAsset.createdAt).toLocaleString("zh-CN")}</span>
                </div>
              </div>
              {onSelectAsset && (
                <button
                  onClick={() => onSelectAsset(previewAsset)}
                  className="mt-auto w-full rounded-xl bg-gray-900 text-white py-2.5 text-xs font-medium hover:bg-gray-700 transition-colors"
                >
                  添加到时间线
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
