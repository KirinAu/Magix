import type { UserInfo, SessionInfo, SessionDetail } from "./types";

const BACKEND = "";

// ─── 用户 & 会话 ──────────────────────────────────────────────────────────────

export async function loginUser(username: string): Promise<UserInfo> {
  const res = await fetch(`${BACKEND}/api/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

export async function listUserSessions(username: string): Promise<SessionInfo[]> {
  const res = await fetch(`${BACKEND}/api/users/${username}/sessions`);
  if (!res.ok) return [];
  return res.json();
}

export async function loadSession(username: string, sessionId: string): Promise<SessionDetail | null> {
  const res = await fetch(`${BACKEND}/api/users/${username}/sessions/${sessionId}`);
  if (!res.ok) return null;
  return res.json();
}

export async function deleteUserSession(username: string, sessionId: string): Promise<void> {
  await fetch(`${BACKEND}/api/users/${username}/sessions/${sessionId}`, { method: "DELETE" });
}

export async function startSession(
  config: { provider: string; modelId: string; apiKey: string; baseUrl?: string },
  onEvent: (event: any) => void,
  username?: string
): Promise<{ sessionId: string; close: () => void }> {
  const res = await fetch(`${BACKEND}/api/chat/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...config, username }),
  });

  const sessionId = res.headers.get("X-Session-Id") ?? "";
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;

  const close = () => {
    closed = true;
    reader.cancel();
  };

  (async () => {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            onEvent(JSON.parse(line.slice(6)));
          } catch {}
        }
      }
    }
  })();

  return { sessionId, close };
}

export async function sendMessage(
  sessionId: string,
  message: string,
  onEvent: (event: any) => void,
  images?: Array<{ type: "base64"; mediaType: string; data: string }>
): Promise<() => void> {
  const res = await fetch(`${BACKEND}/api/chat/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, images }),
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;

  const close = () => {
    closed = true;
    reader.cancel();
  };

  (async () => {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            onEvent(JSON.parse(line.slice(6)));
          } catch {}
        }
      }
    }
  })();

  return close;
}

export async function abortSession(sessionId: string): Promise<void> {
  await fetch(`${BACKEND}/api/chat/${sessionId}/abort`, { method: "POST" }).catch(() => {});
}

export async function submitRender(params: {
  code: string;
  library: string;
  fps: number;
  duration: number;
  width: number;
  height: number;
  username?: string;
  sessionId?: string;
}): Promise<string> {
  const res = await fetch(`${BACKEND}/api/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const { jobId } = await res.json();
  return jobId;
}

export function watchRenderJob(
  jobId: string,
  onUpdate: (job: any) => void
): () => void {
  const es = new EventSource(`${BACKEND}/api/render/${jobId}`);
  es.onmessage = (e) => {
    try {
      onUpdate(JSON.parse(e.data));
    } catch {}
  };
  es.onerror = () => es.close();
  return () => es.close();
}

export function getDownloadUrl(jobId: string): string {
  return `${BACKEND}/api/render/${jobId}/download`;
}

// 直接用静态路由访问已保存的视频文件（服务重启后仍有效）
export function getVideoUrl(filename: string): string {
  return `${BACKEND}/outputs/${filename}`;
}
