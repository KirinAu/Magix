"use client";

import { useEffect, useRef, useState } from "react";
import type { Clip } from "@/lib/types";

interface VideoTimelineProps {
  clips: Clip[];
  currentTime: number;
  onClipsChange: (clips: Clip[]) => void;
  onCurrentTimeChange: (time: number) => void;
  pixelsPerSecond?: number;
}

const SNAP_THRESHOLD = 8;
const TRACK_HEIGHT = 80;
const RULER_HEIGHT = 40;

export default function VideoTimeline({
  clips,
  currentTime,
  onClipsChange,
  onCurrentTimeChange,
  pixelsPerSecond = 60,
}: VideoTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{
    clipId: string;
    type: "move" | "trim-start" | "trim-end";
    startX: number;
    startTime: number;
    startTrimStart?: number;
    startTrimEnd?: number;
  } | null>(null);
  const [hoveredClip, setHoveredClip] = useState<string | null>(null);

  const totalDuration = clips.reduce((sum, c) => {
    const duration = (c.trimEnd > 0 ? c.trimEnd : (c.assetDuration ?? 0)) - c.trimStart;
    return sum + Math.max(0, duration);
  }, 0);

  const timelineWidth = Math.max(1200, totalDuration * pixelsPerSecond + 200);

  function getClipStartTime(clipId: string): number {
    let time = 0;
    for (const c of clips) {
      if (c.clipId === clipId) return time;
      const duration = (c.trimEnd > 0 ? c.trimEnd : (c.assetDuration ?? 0)) - c.trimStart;
      time += Math.max(0, duration);
    }
    return time;
  }

  function findSnapPoints(excludeClipId: string): number[] {
    const points: number[] = [0];
    let time = 0;
    for (const c of clips) {
      if (c.clipId !== excludeClipId) {
        points.push(time);
        const duration = (c.trimEnd > 0 ? c.trimEnd : (c.assetDuration ?? 0)) - c.trimStart;
        time += Math.max(0, duration);
        points.push(time);
      } else {
        const duration = (c.trimEnd > 0 ? c.trimEnd : (c.assetDuration ?? 0)) - c.trimStart;
        time += Math.max(0, duration);
      }
    }
    return points;
  }

  function snapToPoint(time: number, snapPoints: number[]): number {
    const threshold = SNAP_THRESHOLD / pixelsPerSecond;
    for (const point of snapPoints) {
      if (Math.abs(time - point) < threshold) return point;
    }
    return time;
  }

  function handleMouseDown(e: React.MouseEvent, clipId: string, type: "move" | "trim-start" | "trim-end") {
    e.stopPropagation();
    const clip = clips.find((c) => c.clipId === clipId);
    if (!clip) return;

    setDragging({
      clipId,
      type,
      startX: e.clientX,
      startTime: getClipStartTime(clipId),
      startTrimStart: clip.trimStart,
      startTrimEnd: clip.trimEnd,
    });
  }

  useEffect(() => {
    if (!dragging) return;

    function handleMouseMove(e: MouseEvent) {
      if (!dragging) return;

      const deltaX = e.clientX - dragging.startX;
      const deltaTime = deltaX / pixelsPerSecond;
      const clip = clips.find((c) => c.clipId === dragging.clipId);
      if (!clip) return;

      if (dragging.type === "move") {
        const newStartTime = Math.max(0, dragging.startTime + deltaTime);
        const snapPoints = findSnapPoints(dragging.clipId);
        const snappedTime = snapToPoint(newStartTime, snapPoints);

        const clipIndex = clips.findIndex((c) => c.clipId === dragging.clipId);
        const clipDuration = (clip.trimEnd > 0 ? clip.trimEnd : (clip.assetDuration ?? 0)) - clip.trimStart;

        let targetIndex = 0;
        let accTime = 0;
        for (let i = 0; i < clips.length; i++) {
          if (clips[i].clipId === dragging.clipId) continue;
          const dur = (clips[i].trimEnd > 0 ? clips[i].trimEnd : (clips[i].assetDuration ?? 0)) - clips[i].trimStart;
          if (snappedTime >= accTime + dur / 2) {
            targetIndex = i + 1;
          }
          accTime += dur;
        }

        if (targetIndex !== clipIndex && targetIndex !== clipIndex + 1) {
          const newClips = clips.filter((c) => c.clipId !== dragging.clipId);
          newClips.splice(targetIndex > clipIndex ? targetIndex - 1 : targetIndex, 0, clip);
          onClipsChange(newClips);
        }
      } else if (dragging.type === "trim-start") {
        const newTrimStart = Math.max(0, Math.min(
          (dragging.startTrimStart ?? 0) + deltaTime,
          clip.assetDuration ?? 0
        ));
        const newClips = clips.map((c) =>
          c.clipId === dragging.clipId ? { ...c, trimStart: newTrimStart } : c
        );
        onClipsChange(newClips);
      } else if (dragging.type === "trim-end") {
        const newTrimEnd = Math.max(0, Math.min(
          (dragging.startTrimEnd ?? 0) + deltaTime,
          clip.assetDuration ?? 0
        ));
        const newClips = clips.map((c) =>
          c.clipId === dragging.clipId ? { ...c, trimEnd: newTrimEnd } : c
        );
        onClipsChange(newClips);
      }
    }

    function handleMouseUp() {
      setDragging(null);
    }

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, clips, pixelsPerSecond, onClipsChange]);

  function handleTimelineClick(e: React.MouseEvent) {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = Math.max(0, x / pixelsPerSecond);
    onCurrentTimeChange(Math.min(time, totalDuration));
  }

  return (
    <div className="flex flex-col bg-gray-900 rounded-xl overflow-hidden">
      <div className="relative" style={{ height: RULER_HEIGHT + TRACK_HEIGHT }}>
        <div
          ref={containerRef}
          className="absolute inset-0 overflow-x-auto overflow-y-hidden"
          onClick={handleTimelineClick}
        >
          <div style={{ width: timelineWidth, height: "100%" }}>
            <div
              className="relative border-b border-gray-700"
              style={{ height: RULER_HEIGHT }}
            >
              {Array.from({ length: Math.ceil(totalDuration) + 1 }).map((_, i) => (
                <div
                  key={i}
                  className="absolute top-0 bottom-0 border-l border-gray-600"
                  style={{ left: i * pixelsPerSecond }}
                >
                  <span className="absolute top-1 left-1 text-[10px] text-gray-400">
                    {formatDuration(i)}
                  </span>
                </div>
              ))}

              <div
                className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-20 pointer-events-none"
                style={{ left: currentTime * pixelsPerSecond }}
              >
                <div className="absolute -top-1 -left-1.5 w-3 h-3 bg-red-500 rounded-full" />
              </div>
            </div>

            <div className="relative" style={{ height: TRACK_HEIGHT }}>
              {clips.map((clip) => {
                const startTime = getClipStartTime(clip.clipId);
                const duration = (clip.trimEnd > 0 ? clip.trimEnd : (clip.assetDuration ?? 0)) - clip.trimStart;
                const width = duration * pixelsPerSecond;
                const isHovered = hoveredClip === clip.clipId;
                const isDragging = dragging?.clipId === clip.clipId;

                return (
                  <div
                    key={clip.clipId}
                    className={`absolute top-2 bottom-2 rounded-lg transition-all ${
                      isDragging ? "opacity-70 shadow-2xl" : isHovered ? "shadow-lg" : "shadow"
                    }`}
                    style={{
                      left: startTime * pixelsPerSecond,
                      width,
                      background: "linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)",
                      cursor: "grab",
                    }}
                    onMouseDown={(e) => handleMouseDown(e, clip.clipId, "move")}
                    onMouseEnter={() => setHoveredClip(clip.clipId)}
                    onMouseLeave={() => setHoveredClip(null)}
                  >
                    <div className="absolute inset-0 flex items-center justify-center px-2 overflow-hidden">
                      <span className="text-xs text-white font-medium truncate">
                        {clip.assetName || "未命名"}
                      </span>
                    </div>

                    <div
                      className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize bg-blue-300 opacity-0 hover:opacity-100 transition-opacity"
                      onMouseDown={(e) => handleMouseDown(e, clip.clipId, "trim-start")}
                    />
                    <div
                      className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize bg-blue-300 opacity-0 hover:opacity-100 transition-opacity"
                      onMouseDown={(e) => handleMouseDown(e, clip.clipId, "trim-end")}
                    />

                    {isHovered && (
                      <div className="absolute -top-6 left-0 bg-gray-800 text-white text-[10px] px-2 py-0.5 rounded whitespace-nowrap">
                        {formatDuration(clip.trimStart)} - {formatDuration(clip.trimEnd > 0 ? clip.trimEnd : (clip.assetDuration ?? 0))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-t border-gray-700">
        <div className="text-xs text-gray-400">
          {clips.length} 个片段 · 总时长 {formatDuration(totalDuration)}
        </div>
        <div className="text-xs text-white font-mono">
          {formatDuration(currentTime)} / {formatDuration(totalDuration)}
        </div>
      </div>
    </div>
  );
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
}
