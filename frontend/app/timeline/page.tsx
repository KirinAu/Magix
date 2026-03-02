"use client";

import { useEffect, useState } from "react";
import AssetLibrary from "@/components/AssetLibrary";
import TimelinePanel from "@/components/TimelinePanel";
import LoginModal from "@/components/LoginModal";
import type { Asset, UserInfo } from "@/lib/types";

export default function TimelinePage() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [showAssetLibrary, setShowAssetLibrary] = useState(false);
  const [assetLibraryRefreshTick, setAssetLibraryRefreshTick] = useState(0);
  const [timelineRefreshTick, setTimelineRefreshTick] = useState(0);
  const [incomingAsset, setIncomingAsset] = useState<Asset | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("me_user");
    if (saved) {
      try { setUser(JSON.parse(saved)); } catch {}
    }
  }, []);

  function handleLogin(u: UserInfo) {
    setUser(u);
    localStorage.setItem("me_user", JSON.stringify(u));
  }

  return (
    <div className="h-screen bg-gray-50 flex flex-col overflow-hidden">
      {!user && <LoginModal onLogin={handleLogin} />}

      <header className="h-14 bg-white border-b border-gray-100 flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { window.location.href = "/"; }}
            className="rounded-xl border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
          >
            返回
          </button>
          <span className="text-sm font-semibold text-gray-900">时间线编辑</span>
        </div>
        {user && <span className="text-xs text-gray-500">{user.username}</span>}
      </header>

      <main className="flex-1 p-4 overflow-hidden">
        {user && (
          <TimelinePanel
            username={user.username}
            embedded
            refreshTick={timelineRefreshTick}
            incomingAsset={incomingAsset}
            onIncomingAssetConsumed={() => {
              setIncomingAsset(null);
              setTimelineRefreshTick((t) => t + 1);
            }}
            onOpenAssetLibrary={() => setShowAssetLibrary(true)}
          />
        )}
      </main>

      {showAssetLibrary && user && (
        <AssetLibrary
          username={user.username}
          onClose={() => setShowAssetLibrary(false)}
          refreshTick={assetLibraryRefreshTick}
          onSelectAsset={(asset) => {
            setIncomingAsset(asset);
            setShowAssetLibrary(false);
          }}
          onAssetDeleted={() => {
            setTimelineRefreshTick((t) => t + 1);
          }}
        />
      )}
    </div>
  );
}
