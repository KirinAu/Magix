"use client";

import { useState } from "react";
import { loginUser } from "@/lib/api";
import type { UserInfo } from "@/lib/types";

interface LoginModalProps {
  onLogin: (user: UserInfo) => void;
}

export default function LoginModal({ onLogin }: LoginModalProps) {
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    setLoading(true);
    setError("");
    try {
      const user = await loginUser(username.trim());
      onLogin(user);
    } catch (err: any) {
      setError(err.message || "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-80 flex flex-col gap-5">
        <div>
          <div className="w-8 h-8 bg-gray-900 rounded-xl mb-4" />
          <p className="text-base font-semibold text-gray-900">欢迎使用 MagicEffect</p>
          <p className="text-xs text-gray-400 mt-1">输入用户名开始，不存在会自动创建</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            autoFocus
            type="text"
            placeholder="用户名（字母/数字/下划线）"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="rounded-xl bg-gray-50 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none focus:ring-2 focus:ring-gray-200"
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={!username.trim() || loading}
            className="rounded-xl bg-gray-900 text-white py-2.5 text-sm font-medium disabled:opacity-40 hover:bg-gray-700 transition-colors"
          >
            {loading ? "登录中..." : "进入"}
          </button>
        </form>
      </div>
    </div>
  );
}
