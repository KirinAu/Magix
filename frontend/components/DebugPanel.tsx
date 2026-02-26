"use client";

import { useEffect, useRef, useState } from "react";
import type { LogEntry } from "@/lib/types";

interface DebugPanelProps {
  logs: LogEntry[];
  onClear: () => void;
}

const kindColor: Record<string, string> = {
  info:     "text-gray-400",
  thinking: "text-purple-400",
  tool:     "text-blue-400",
  error:    "text-red-400",
  request:  "text-yellow-400",
};

const kindLabel: Record<string, string> = {
  info:     "INFO",
  thinking: "THINK",
  tool:     "TOOL",
  error:    "ERR",
  request:  "REQ",
};

export default function DebugPanel({ logs, onClear }: DebugPanelProps) {
  const [open, setOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, open]);

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="shrink-0 border-t border-gray-200 bg-gray-950 font-mono text-xs">
      {/* header */}
      <div className="flex items-center gap-3 px-4 py-2 cursor-pointer select-none" onClick={() => setOpen((v) => !v)}>
        <span className="text-gray-500">{open ? "▾" : "▸"}</span>
        <span className="text-gray-400 font-semibold tracking-wide">DEBUG</span>
        <span className="text-gray-600">{logs.length} entries</span>
        <div className="flex-1" />
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            className="text-gray-600 hover:text-gray-400 transition-colors"
          >
            clear
          </button>
        )}
      </div>

      {open && (
        <div className="h-48 overflow-y-auto px-4 pb-3 space-y-0.5">
          {logs.length === 0 && (
            <p className="text-gray-600 mt-2">no logs yet</p>
          )}
          {logs.map((log) => {
            const expanded = expandedIds.has(log.id);
            const ts = new Date(log.timestamp).toISOString().slice(11, 23);
            return (
              <div key={log.id}>
                <div
                  className={`flex gap-2 items-start leading-5 ${log.detail ? "cursor-pointer" : ""}`}
                  onClick={() => log.detail && toggleExpand(log.id)}
                >
                  <span className="text-gray-600 shrink-0">{ts}</span>
                  <span className={`shrink-0 w-12 ${kindColor[log.kind]}`}>[{kindLabel[log.kind]}]</span>
                  <span className="text-gray-300 break-all">{log.label}</span>
                  {log.detail && (
                    <span className="text-gray-600 shrink-0 ml-auto">{expanded ? "▴" : "▾"}</span>
                  )}
                </div>
                {expanded && log.detail && (
                  <pre className="mt-0.5 ml-20 text-gray-500 whitespace-pre-wrap break-all">{log.detail}</pre>
                )}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
