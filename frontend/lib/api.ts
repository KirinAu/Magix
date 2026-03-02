import type { UserInfo, SessionInfo, SessionDetail, Asset, Project, ProjectDetail, Clip } from "./types";

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
  if (!res.ok) {
    let error = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      error = body?.error || error;
    } catch {}
    throw new Error(error);
  }

  const sessionId = res.headers.get("X-Session-Id") ?? "";
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;
  let isReady = false;
  let readyResolve: () => void = () => {};
  let readyReject: (reason?: unknown) => void = () => {};

  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const close = () => {
    closed = true;
    reader.cancel();
    if (!isReady) readyReject(new Error("Session closed before ready"));
  };

  (async () => {
    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const evt = JSON.parse(line.slice(6));
              onEvent(evt);
              if (evt.type === "session_ready") {
                isReady = true;
                readyResolve();
              }
              if (evt.type === "error" && !isReady) {
                readyReject(new Error(evt.message || "Session init failed"));
              }
            } catch {}
          }
        }
      }
      if (!closed && !isReady) readyReject(new Error("Session ended before ready"));
    } catch (err) {
      if (!isReady) readyReject(err);
    }
  })();

  await ready;
  return { sessionId, close };
}

export async function sendMessage(
  sessionId: string,
  message: string,
  onEvent: (event: any) => void,
  images?: Array<{ type: "base64"; mediaType: string; data: string }>,
  username?: string,
  llmConfig?: { provider: string; modelId: string; apiKey: string; baseUrl?: string }
): Promise<() => void> {
  const res = await fetch(`${BACKEND}/api/chat/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, images, username, llmConfig }),
  });
  if (!res.ok) {
    let error = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      error = body?.error || error;
    } catch {}
    throw new Error(error);
  }

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

export async function stopRenderJob(jobId: string): Promise<void> {
  await fetch(`${BACKEND}/api/render/${jobId}/stop`, { method: "POST" });
}

// 直接用静态路由访问已保存的视频文件（服务重启后仍有效）
export function getVideoUrl(filename: string): string {
  return `${BACKEND}/api/outputs/${filename}`;
}

// ─── 素材库 ───────────────────────────────────────────────────────────────────

export async function listUserAssets(username: string): Promise<Asset[]> {
  const res = await fetch(`${BACKEND}/api/users/${username}/assets`);
  if (!res.ok) return [];
  return res.json();
}

export async function deleteUserAsset(username: string, assetId: string): Promise<void> {
  await fetch(`${BACKEND}/api/users/${username}/assets/${assetId}`, { method: "DELETE" });
}

export async function renameUserAsset(username: string, assetId: string, name: string): Promise<void> {
  await fetch(`${BACKEND}/api/users/${username}/assets/${assetId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export function getAssetStreamUrl(assetId: string): string {
  return `${BACKEND}/api/assets/${assetId}/stream`;
}

// ─── 短片项目 & 时间线 ────────────────────────────────────────────────────────

export async function listUserProjects(username: string): Promise<Project[]> {
  const res = await fetch(`${BACKEND}/api/users/${username}/projects`);
  if (!res.ok) return [];
  return res.json();
}

export async function createUserProject(username: string, name: string): Promise<Project> {
  const res = await fetch(`${BACKEND}/api/users/${username}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return res.json();
}

export async function loadProject(username: string, projectId: string): Promise<ProjectDetail | null> {
  const res = await fetch(`${BACKEND}/api/users/${username}/projects/${projectId}`);
  if (!res.ok) return null;
  return res.json();
}

export async function updateUserProject(username: string, projectId: string, patch: Partial<Project>): Promise<void> {
  await fetch(`${BACKEND}/api/users/${username}/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function deleteUserProject(username: string, projectId: string): Promise<void> {
  await fetch(`${BACKEND}/api/users/${username}/projects/${projectId}`, { method: "DELETE" });
}

export async function saveProjectClips(username: string, projectId: string, clips: Array<{ clipId: string; assetId: string; position: number; trimStart: number; trimEnd: number }>): Promise<Clip[]> {
  const res = await fetch(`${BACKEND}/api/users/${username}/projects/${projectId}/clips`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clips }),
  });
  return res.json();
}

export async function exportProject(username: string, projectId: string): Promise<{ status: string }> {
  const res = await fetch(`${BACKEND}/api/users/${username}/projects/${projectId}/export`, {
    method: "POST",
  });
  return res.json();
}

export function getProjectDownloadUrl(username: string, projectId: string): string {
  return `${BACKEND}/api/users/${username}/projects/${projectId}/download`;
}
