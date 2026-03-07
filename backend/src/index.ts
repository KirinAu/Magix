import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { createAnimationAgent, sendSSE, type LLMConfig } from "./agent";

import { renderFrames } from "./renderer";
import { encodeToMp4, cleanupFrames, getVideoDuration, concatVideos } from "./encoder";
import {
  ensureUser,
  createSession,
  getSession,
  updateSession,
  deleteSession,
  listSessions,
  createRenderJob,
  updateRenderJob,
  getRenderJob,
  getSessionRenderJob,
  createAsset,
  getAsset,
  listAssets,
  deleteAsset,
  renameAsset,
  createProject,
  getProject,
  listProjects,
  updateProject,
  deleteProject,
  addClip,
  listClips,
  removeClip,
  replaceClips,
  type ChatMessage as StoredMessage,
} from "./store";

interface Session {
  agent: any;
  setRes: (r: import("express").Response) => void;
  username: string;
  messages: StoredMessage[];
  currentCode: string;
  currentLibrary: string;
  ready: boolean;
}

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "outputs");
const OUTPUT_DIR = path.join(DATA_DIR, "outputs");
const CONFIG_FILE = path.join(DATA_DIR, "llm_config.json");
const PI_SESSION_DIR = path.join(DATA_DIR, "pi_sessions");
const GEMINI_RELAY_BASE_URL = process.env.GEMINI_RELAY_BASE_URL?.replace(/\/+$/, "");
const GEMINI_RELAY_API_KEY = process.env.GEMINI_RELAY_API_KEY;

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/outputs", express.static(OUTPUT_DIR));
app.use("/libs", express.static(path.join(process.cwd(), "libs")));

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(PI_SESSION_DIR, { recursive: true });

let cachedSessionManagerCtor: any | null = null;

async function loadSessionManagerCtor() {
  if (cachedSessionManagerCtor) return cachedSessionManagerCtor;
  // eslint-disable-next-line no-new-func
  const mod = await (new Function('return import("@mariozechner/pi-coding-agent")')() as Promise<typeof import("@mariozechner/pi-coding-agent")>);
  cachedSessionManagerCtor = mod.SessionManager;
  return cachedSessionManagerCtor;
}

function getPiSessionFile(sessionId: string): string {
  return path.join(PI_SESSION_DIR, `${sessionId}.jsonl`);
}

function mapProviderToApi(provider: string): string {
  if (provider === "anthropic") return "anthropic-messages";
  if (provider === "google") return "google-generative-ai";
  return "openai-completions";
}

function createZeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function loadPersistedConfig(): LLMConfig | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as LLMConfig;
  } catch {
    return null;
  }
}

function getGeminiUpstreamBaseUrl(): string {
  if (GEMINI_RELAY_BASE_URL) return GEMINI_RELAY_BASE_URL;
  const persisted = loadPersistedConfig();
  if (persisted?.provider === "google" && persisted.baseUrl) {
    return persisted.baseUrl.replace(/\/+$/, "");
  }
  return "https://generativelanguage.googleapis.com";
}

function getGeminiUpstreamApiKey(req: express.Request): string | undefined {
  const queryKey = typeof req.query.key === "string" ? req.query.key : undefined;
  const headerKey = req.header("x-goog-api-key") || undefined;
  if (queryKey) return queryKey;
  if (headerKey) return headerKey;
  if (GEMINI_RELAY_API_KEY) return GEMINI_RELAY_API_KEY;
  const persisted = loadPersistedConfig();
  if (persisted?.provider === "google" && persisted.apiKey) return persisted.apiKey;
  return undefined;
}

function validateGeminiGenerateContentBody(body: any): string | null {
  if (!body || typeof body !== "object") return "request body must be a JSON object";
  if (!Array.isArray(body.contents)) return "contents must be an array";

  for (const content of body.contents) {
    if (!content || typeof content !== "object") return "each contents item must be an object";
    if (!Array.isArray(content.parts)) return "each contents item must include parts array";

    for (const part of content.parts) {
      if (!part || typeof part !== "object") return "each part must be an object";
      if (part.fileData) {
        return "fileData.fileUri and File API are not supported; use inlineData base64 instead";
      }
      if (!part.inlineData) continue;

      const { mimeType, data } = part.inlineData;
      if (!mimeType || typeof mimeType !== "string") {
        return "inlineData.mimeType is required";
      }
      if (!data || typeof data !== "string") {
        return "inlineData.data is required and must be base64";
      }

      const allowed = mimeType.startsWith("image/")
        || mimeType === "application/pdf"
        || mimeType.startsWith("audio/")
        || mimeType.startsWith("video/");
      if (!allowed) {
        return `unsupported inlineData.mimeType: ${mimeType}`;
      }
    }
  }

  return null;
}

async function proxyGeminiRequest(req: express.Request, res: express.Response, model: string, action: "generateContent" | "streamGenerateContent") {
  const error = validateGeminiGenerateContentBody(req.body);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  const upstreamBaseUrl = getGeminiUpstreamBaseUrl();
  const apiKey = getGeminiUpstreamApiKey(req);
  const upstreamUrl = new URL(`${upstreamBaseUrl}/v1beta/models/${encodeURIComponent(model)}:${action}`);

  for (const [key, value] of Object.entries(req.query)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) upstreamUrl.searchParams.append(key, String(item));
    } else {
      upstreamUrl.searchParams.set(key, String(value));
    }
  }
  if (apiKey && !upstreamUrl.searchParams.has("key")) {
    upstreamUrl.searchParams.set("key", apiKey);
  }

  const headers = new Headers();
  req.headers && Object.entries(req.headers).forEach(([key, value]) => {
    if (!value) return;
    const lower = key.toLowerCase();
    if (["host", "connection", "content-length", "x-goog-api-key"].includes(lower)) return;
    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
      return;
    }
    headers.set(key, value);
  });
  headers.set("Content-Type", "application/json");

  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(req.body),
  });

  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (["content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) return;
    res.setHeader(key, value);
  });

  if (action === "streamGenerateContent") {
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Cache-Control", "no-cache");
  }

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

async function openOrCreateFrameworkSessionManager(sessionId: string, createIfMissing = true): Promise<any | null> {
  const SessionManager = await loadSessionManagerCtor();
  const sessionFile = getPiSessionFile(sessionId);
  if (fs.existsSync(sessionFile)) {
    return SessionManager.open(sessionFile, PI_SESSION_DIR);
  }
  if (!createIfMissing) return null;

  const manager = SessionManager.create(process.cwd(), PI_SESSION_DIR);
  const generated = manager.getSessionFile?.();
  if (generated && generated !== sessionFile) {
    // SessionManager may not have flushed the generated file to disk yet.
    // Always switch the active file path first; only touch files if they exist.
    manager.setSessionFile?.(sessionFile);
    if (fs.existsSync(generated) && fs.existsSync(sessionFile)) {
      try { fs.unlinkSync(generated); } catch {}
    } else if (fs.existsSync(generated) && !fs.existsSync(sessionFile)) {
      try { fs.renameSync(generated, sessionFile); } catch {}
    }
  } else {
    manager.setSessionFile?.(sessionFile);
  }
  return manager;
}

function hydrateSessionManagerFromStoredMessages(sessionManager: any, messages: StoredMessage[], config: LLMConfig): void {
  if (!sessionManager || !Array.isArray(messages)) return;
  if ((sessionManager.getEntries?.() ?? []).length > 0) return;

  const api = mapProviderToApi(config.provider);
  for (const m of messages) {
    if (m.role === "user") {
      sessionManager.appendMessage({
        role: "user",
        content: m.content,
        timestamp: m.timestamp || Date.now(),
      });
      continue;
    }

    if (m.role === "assistant" || m.role === "thinking") {
      const text = m.role === "thinking" ? `[thinking]\n${m.content}` : m.content;
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text }],
        api,
        provider: config.provider,
        model: config.modelId,
        usage: createZeroUsage(),
        stopReason: "stop",
        timestamp: m.timestamp || Date.now(),
      });
    }
  }
}

// ─── LLM 配置持久化 ───────────────────────────────────────────────────────────

app.get("/api/config", (_req, res) => {
  try {
    if (!fs.existsSync(CONFIG_FILE)) { res.json(null); return; }
    res.json(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")));
  } catch {
    res.json(null);
  }
});

app.put("/api/config", (req, res) => {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(req.body), "utf-8");
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post(/^\/v1beta\/models\/([^/]+):(generateContent|streamGenerateContent)$/, async (req, res) => {
  const match = req.path.match(/^\/v1beta\/models\/([^/]+):(generateContent|streamGenerateContent)$/);
  const model = match?.[1];
  const action = match?.[2] as "generateContent" | "streamGenerateContent" | undefined;

  if (!model || !action) {
    res.status(404).json({ error: "Route not found" });
    return;
  }

  try {
    await proxyGeminiRequest(req, res, model, action);
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(502).json({ error: err?.message || "Gemini relay request failed" });
      return;
    }
    if (!res.writableEnded) res.end();
  }
});

// ─── 用户系统 ─────────────────────────────────────────────────────────────────

/**
 * POST /api/users/login
 * 用用户名登录（不存在则自动注册）
 */
app.post("/api/users/login", (req, res) => {
  const { username } = req.body;
  if (!username || typeof username !== "string" || !username.trim()) {
    res.status(400).json({ error: "username is required" });
    return;
  }
  const clean = username.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!clean) { res.status(400).json({ error: "invalid username" }); return; }
  const user = ensureUser(clean);
  res.json({ username: user.username, createdAt: user.createdAt });
});

/**
 * GET /api/users/:username/sessions
 * 列出用户所有会话（不含消息体）
 */
app.get("/api/users/:username/sessions", (req, res) => {
  const sessions = listSessions(req.params.username);
  res.json(sessions);
});

/**
 * POST /api/users/:username/sessions
 * 创建新会话（手动保存代码时使用）
 */
app.post("/api/users/:username/sessions", (req, res) => {
  const { username } = req.params;
  const { title, code, library } = req.body;

  ensureUser(username);
  const sessionId = uuidv4();
  createSession(username, sessionId);
  updateSession(username, sessionId, {
    title: title || "未命名会话",
    code: code || "",
    library: library || "gsap",
    videoPath: null,
  });

  res.json({ sessionId, username, title: title || "未命名会话" });
});

/**
 * GET /api/users/:username/sessions/:sessionId
 * 获取会话详情（含消息 + 最新渲染 job）
 */
app.get("/api/users/:username/sessions/:sessionId", (req, res) => {
  const session = getSession(req.params.username, req.params.sessionId);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }
  const renderJob = getSessionRenderJob(req.params.sessionId);
  res.json({ ...session, renderJob: renderJob ?? null });
});

/**
 * DELETE /api/users/:username/sessions/:sessionId
 * 删除会话
 */
app.delete("/api/users/:username/sessions/:sessionId", (req, res) => {
  const ok = deleteSession(req.params.username, req.params.sessionId);
  if (!ok) { res.status(404).json({ error: "Session not found" }); return; }
  res.json({ ok: true });
});

/**
 * PUT /api/users/:username/sessions/:sessionId
 * 更新会话（保存代码）
 */
app.put("/api/users/:username/sessions/:sessionId", (req, res) => {
  const { username, sessionId } = req.params;
  const { code, library, title } = req.body;

  const session = getSession(username, sessionId);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  updateSession(username, sessionId, {
    title: title ?? session.title,
    code: code ?? session.code,
    library: library ?? session.library,
    videoPath: session.videoPath,
  });

  res.json({ ok: true });
});

// ─── Agent 会话管理 ───────────────────────────────────────────────────────────

const sessions = new Map<string, Session>();
const renderAbortControllers = new Map<string, AbortController>();

async function restoreRuntimeSession(
  sessionId: string,
  username: string | undefined,
  res: import("express").Response,
  runtimeConfig?: LLMConfig
): Promise<Session | undefined> {
  if (!username) return undefined;
  const normalized = username.trim().toLowerCase();
  if (!normalized) return undefined;

  const stored = getSession(normalized, sessionId);
  if (!stored) return undefined;

  const config = runtimeConfig?.apiKey && runtimeConfig?.modelId ? runtimeConfig : loadPersistedConfig();
  if (!config?.apiKey || !config?.modelId) return undefined;

  const sessionManager = await openOrCreateFrameworkSessionManager(sessionId, true);
  if (!sessionManager) return undefined;
  hydrateSessionManagerFromStoredMessages(sessionManager, stored.messages, config);

  const { session, setRes } = await createAnimationAgent(config, res, {
    sessionManager,
    initialCode: stored.code,
    initialLibrary: stored.library,
  });

  const restored: Session = {
    agent: session,
    setRes,
    username: normalized,
    messages: [...stored.messages],
    currentCode: stored.code,
    currentLibrary: stored.library,
    ready: true,
  };
  sessions.set(sessionId, restored);
  return restored;
}

/**
 * POST /api/chat/start
 * 创建新的 Agent 会话，返回 sessionId
 * Body: LLMConfig + { username }
 */
app.post("/api/chat/start", async (req, res) => {
  const { username, ...config } = req.body as LLMConfig & { username?: string };
  if (!config?.apiKey || !config?.modelId) {
    res.status(400).json({ error: "apiKey and modelId are required" });
    return;
  }

  const sessionId = uuidv4();
  const resolvedUsername = username?.trim().toLowerCase() || "anonymous";

  createSession(resolvedUsername, sessionId);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Session-Id", sessionId);
  res.flushHeaders();

  // Pre-create the session object so Agno can reference it via closure
  const memSession: Session = {
    agent: null as any,
    setRes: () => {},
    username: resolvedUsername,
    messages: [],
    currentCode: "",
    currentLibrary: "gsap",
    ready: false,
  };
  sessions.set(sessionId, memSession);

  try {
    const sessionManager = await openOrCreateFrameworkSessionManager(sessionId, true);
    const { session, setRes } = await createAnimationAgent(config, res, { sessionManager });
    memSession.agent = session;
    memSession.setRes = setRes;
    memSession.ready = true;
    sendSSE(res, { type: "session_ready", sessionId });
    res.end();
  } catch (err: any) {
    sessions.delete(sessionId);
    sendSSE(res, { type: "error", message: err?.message || "Failed to initialize session" });
    res.end();
  }
});

/**
 * POST /api/chat/:sessionId/message
 * 向已有会话发送消息，SSE 流式返回
 * Body: { message, username? }
 */
app.post("/api/chat/:sessionId/message", async (req, res) => {
  const { sessionId } = req.params;
  const { message, images, username, llmConfig } = req.body;  // images: Array<{ type: "base64", mediaType: string, data: string }>

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  let session = sessions.get(sessionId);
  if (!session) {
    session = await restoreRuntimeSession(sessionId, username, res, llmConfig);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
  }

  if (!session.ready || !session.agent) {
    res.status(409).json({ error: "Session is not ready yet" });
    return;
  }

  // 记录用户消息
  const userMsg: StoredMessage = { role: "user", content: message, timestamp: Date.now() };
  session.messages.push(userMsg);

  // 如果是第一条消息，用它作为会话标题
  const stored = getSession(session.username, sessionId);
  if (stored && stored.messages.length === 0) {
    updateSession(session.username, sessionId, {
      title: message.slice(0, 60),
    });
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  session.setRes(res);

  // 拦截 SSE 写入，同时收集 assistant 消息和代码更新
  let assistantBuffer = "";
  let currentToolName = "";
  const origRes = res;

  // 监听 code_update 和 agent_end 事件来更新 store
  const origWrite = res.write.bind(res);
  (res as any).write = (chunk: any, ...args: any[]) => {
    const result = origWrite(chunk, ...args);
    try {
      const str = typeof chunk === "string" ? chunk : chunk.toString();
      const lines = str.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const evt = JSON.parse(line.slice(6));

        if (evt.type === "code_update") {
          session.currentCode = evt.code ?? session.currentCode;
          session.currentLibrary = evt.library ?? session.currentLibrary;
        }

        if (evt.type === "tool_execution_start") {
          currentToolName = evt.toolName ?? "";
        }

        if (evt.type === "tool_execution_end") {
          const name = evt.toolName ?? currentToolName;
          const label = name === "commit_code" ? "生成代码"
            : name === "str_replace" ? "修改代码"
            : name === "read_code" ? "查看代码"
            : name === "validate_code" ? "检查代码" : name;
          session.messages.push({ role: "tool", content: label, toolName: name, timestamp: Date.now() });
          currentToolName = "";
        }

        if (evt.type === "message_update") {
          const ae = evt.assistantMessageEvent;
          if (ae?.type === "text_delta") assistantBuffer += ae.delta;
        }

        if (evt.type === "turn_end") {
          const text = assistantBuffer.trim();
          if (text) {
            session.messages.push({ role: "assistant", content: text, timestamp: Date.now() });
          }
          assistantBuffer = "";
        }

        if (evt.type === "agent_end") {
          // Sync messages from real agent state back to our wrapper
          try {
            const agentState = session.agent?.state || session.agent?._state;
            if (agentState && Array.isArray(agentState.messages)) {
              const realMsgs: StoredMessage[] = [];
              for (const m of agentState.messages) {
                let contentText = "";
                let toolName = "";

                if (Array.isArray(m.content)) {
                  contentText = m.content.map((c: any) => {
                    if (c.type === "text") return c.text;
                    if (c.type === "thinking") return `[Thinking]\n${c.thinking}`;
                    if (c.type === "image") return "[Image Attached]";
                    if (c.type === "toolCall") {
                      toolName = c.name;
                      return `[Tool Call: ${c.name}]\nArgs: ${JSON.stringify(c.arguments || {})}`;
                    }
                    return JSON.stringify(c);
                  }).join("\n");
                } else if (m.role === "toolResult") {
                  toolName = m.toolName || "";
                  let resText = (m.content || []).map((cc: any) => cc?.text ?? "").join("");
                  if (resText.length > 500) resText = `${resText.substring(0, 500)}...`;
                  contentText = `[Tool Result: ${toolName}]\n${resText}`;
                } else {
                  contentText = String(m.content || "");
                }
                
                const storedRole: StoredMessage["role"] | null = m.role === "user"
                  ? "user"
                  : m.role === "assistant"
                    ? "assistant"
                    : m.role === "toolResult"
                      ? "tool"
                      : null;
                if (!storedRole) continue;

                realMsgs.push({
                  role: storedRole,
                  content: contentText,
                  toolName: (m.role === "toolResult" ? m.toolName : toolName) || undefined,
                  timestamp: m.timestamp || Date.now()
                });
              }
              if (realMsgs.length > 0) {
                session.messages = realMsgs;
              }
            }
          } catch(e) {
            console.error("Error sync messages", e);
          }

          // 持久化到 store
          updateSession(session.username, sessionId, {
            messages: [...session.messages],
            code: session.currentCode,
            library: session.currentLibrary,
          });
        }
      }
    } catch {}
    return result;
  };

  // 发送 debug 事件：当前完整历史 + 本条消息
  sendSSE(res, {
    type: "request_debug",
    userMessage: message,
    history: session.messages,
    historyLength: session.messages.length,
  });

  try {
    const sdkImages = (images ?? []).map((img: any) => ({
      type: "image" as const,
      data: img.data,
      mimeType: img.mediaType,
    }));
   await session.agent.prompt(message, { images: sdkImages });
  } catch (err: any) {
    sendSSE(origRes, { type: "error", message: err.message });
    origRes.end();
  }
});

/**
 * DELETE /api/chat/:sessionId
 * 清理内存会话
 */
app.delete("/api/chat/:sessionId", (req, res) => {
  sessions.delete(req.params.sessionId);
  res.json({ ok: true });
});

/**
 * POST /api/chat/:sessionId/abort
 */
app.post("/api/chat/:sessionId/abort", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }
  session.agent.abort();
  // 保存当前进度
  updateSession(session.username, req.params.sessionId, {
    messages: [...session.messages],
    code: session.currentCode,
    library: session.currentLibrary,
  });
  res.json({ ok: true });
});

// ─── 渲染 ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/render
 * Body: { code, library, fps, duration, width, height, username?, sessionId? }
 */
app.post("/api/render", async (req, res) => {
  const { code, library = "auto", fps = 30, duration = 3, width = 1280, height = 720, username, sessionId } = req.body;

  if (!code) {
    res.status(400).json({ error: "code is required" });
    return;
  }

  const jobId = uuidv4();
  const total = Math.ceil(fps * duration);

  // 持久化到 DB（需要 sessionId）
  if (username && sessionId) {
    createRenderJob(jobId, sessionId, username, total);
  }

  res.json({ jobId });

  const framesDir = path.join(OUTPUT_DIR, `frames_${jobId}`);
  const outputFile = path.join(OUTPUT_DIR, `${jobId}.mp4`);
  const abortController = new AbortController();
  renderAbortControllers.set(jobId, abortController);

  try {
    if (username && sessionId) updateRenderJob(jobId, { status: "rendering" });

    await renderFrames(code, {
      library,
      fps,
      duration,
      width,
      height,
      outputDir: framesDir,
      signal: abortController.signal,
      onProgress: (frame, total) => {
        if (username && sessionId) updateRenderJob(jobId, { progress: frame, total });
      },
    });

    if (username && sessionId) updateRenderJob(jobId, { status: "encoding" });

    await encodeToMp4({ framesDir, outputPath: outputFile, fps, width, height, signal: abortController.signal });

    cleanupFrames(framesDir);

    if (username && sessionId) {
      updateRenderJob(jobId, { status: "done", outputFile: `${jobId}.mp4` });
      updateSession(username, sessionId, { videoPath: `${jobId}.mp4` });

      // 自动加入素材库
      try {
        const dur = await getVideoDuration(outputFile);
        createAsset(jobId, username, {
          name: `渲染 ${new Date().toLocaleString("zh-CN")}`,
          filePath: `${jobId}.mp4`,
          duration: dur,
          width, height, fps,
          sourceSessionId: sessionId,
        });
      } catch (e) {
        console.error("Auto-create asset failed:", e);
      }
    }
  } catch (err: any) {
    const isStopped = abortController.signal.aborted || err?.message === "Render stopped";
    if (username && sessionId) {
      updateRenderJob(jobId, {
        status: isStopped ? "stopped" : "error",
        error: isStopped ? "已手动停止" : err.message,
      });
    }
    cleanupFrames(framesDir);
  } finally {
    renderAbortControllers.delete(jobId);
  }
});

/**
 * POST /api/render/:jobId/stop
 */
app.post("/api/render/:jobId/stop", (req, res) => {
  const { jobId } = req.params;
  const controller = renderAbortControllers.get(jobId);
  const job = getRenderJob(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (job.status === "done" || job.status === "error" || job.status === "stopped") {
    res.json({ ok: true, alreadyFinished: true });
    return;
  }
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }
  updateRenderJob(jobId, { status: "stopped", error: "已手动停止" });
  res.json({ ok: true });
});

/**
 * GET /api/render/:jobId  SSE 进度流
 */
app.get("/api/render/:jobId", (req, res) => {
  const job = getRenderJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const interval = setInterval(() => {
    const current = getRenderJob(req.params.jobId);
    if (!current) { clearInterval(interval); res.end(); return; }

    sendSSE(res, {
      status: current.status,
      progress: current.progress,
      total: current.total,
      outputFile: current.outputFile,
      error: current.error,
    });

    if (current.status === "done" || current.status === "error" || current.status === "stopped") {
      clearInterval(interval);
      res.end();
    }
  }, 300);

  req.on("close", () => clearInterval(interval));
});

/**
 * GET /api/render/:jobId/download
 */
app.get("/api/render/:jobId/download", (req, res) => {
  const job = getRenderJob(req.params.jobId);
  if (!job || job.status !== "done" || !job.outputFile) {
    res.status(404).json({ error: "File not ready" });
    return;
  }

  const filePath = path.join(OUTPUT_DIR, job.outputFile);
  res.download(filePath, "animation.mp4");
});

// ─── 素材库 ───────────────────────────────────────────────────────────────────

/**
 * GET /api/users/:username/assets
 */
app.get("/api/users/:username/assets", (req, res) => {
  const assets = listAssets(req.params.username);
  res.json(assets);
});

/**
 * DELETE /api/users/:username/assets/:assetId
 */
app.delete("/api/users/:username/assets/:assetId", (req, res) => {
  const ok = deleteAsset(req.params.assetId, req.params.username);
  if (!ok) { res.status(404).json({ error: "Asset not found" }); return; }
  res.json({ ok: true });
});

/**
 * PATCH /api/users/:username/assets/:assetId
 * Body: { name }
 */
app.patch("/api/users/:username/assets/:assetId", (req, res) => {
  const { name } = req.body;
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  const ok = renameAsset(req.params.assetId, req.params.username, name);
  if (!ok) { res.status(404).json({ error: "Asset not found" }); return; }
  res.json({ ok: true });
});

/**
 * GET /api/assets/:assetId/stream
 * 预览/播放素材视频
 */
app.get("/api/assets/:assetId/stream", (req, res) => {
  const asset = getAsset(req.params.assetId);
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
  // 基本鉴权：通过 query 参数 u 校验 username
  const requestUser = req.query.u as string | undefined;
  if (requestUser && requestUser !== asset.username) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const filePath = path.join(OUTPUT_DIR, asset.filePath);
  if (!fs.existsSync(filePath)) { res.status(404).json({ error: "File not found" }); return; }
  res.sendFile(filePath);
});

// ─── 短片项目 & 时间线 ────────────────────────────────────────────────────────

/**
 * GET /api/users/:username/projects
 */
app.get("/api/users/:username/projects", (req, res) => {
  const projects = listProjects(req.params.username);
  res.json(projects);
});

/**
 * POST /api/users/:username/projects
 * Body: { name }
 */
app.post("/api/users/:username/projects", (req, res) => {
  const { name } = req.body;
  const projectId = uuidv4();
  const project = createProject(projectId, req.params.username, name || "未命名短片");
  res.json(project);
});

/**
 * GET /api/users/:username/projects/:projectId
 * 返回项目详情 + clips
 */
app.get("/api/users/:username/projects/:projectId", (req, res) => {
  const project = getProject(req.params.username, req.params.projectId);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const clips = listClips(req.params.projectId);
  res.json({ ...project, clips });
});

/**
 * PATCH /api/users/:username/projects/:projectId
 * Body: { name?, status? }
 */
app.patch("/api/users/:username/projects/:projectId", (req, res) => {
  const ok = updateProject(req.params.username, req.params.projectId, req.body);
  if (!ok) { res.status(404).json({ error: "Project not found" }); return; }
  res.json({ ok: true });
});

/**
 * DELETE /api/users/:username/projects/:projectId
 */
app.delete("/api/users/:username/projects/:projectId", (req, res) => {
  const ok = deleteProject(req.params.username, req.params.projectId);
  if (!ok) { res.status(404).json({ error: "Project not found" }); return; }
  res.json({ ok: true });
});

/**
 * PUT /api/users/:username/projects/:projectId/clips
 * 整体替换时间线（前端拖拽排序后整体提交）
 * Body: { clips: Array<{ clipId, assetId, position, trimStart, trimEnd }> }
 */
app.put("/api/users/:username/projects/:projectId/clips", (req, res) => {
  const project = getProject(req.params.username, req.params.projectId);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const { clips } = req.body;
  if (!Array.isArray(clips)) { res.status(400).json({ error: "clips array required" }); return; }
  replaceClips(req.params.projectId, clips);
  updateProject(req.params.username, req.params.projectId, {});
  const result = listClips(req.params.projectId);
  res.json(result);
});

/**
 * POST /api/users/:username/projects/:projectId/export
 * 导出/拼接时间线为最终视频
 */
app.post("/api/users/:username/projects/:projectId/export", async (req, res) => {
  const project = getProject(req.params.username, req.params.projectId);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const clips = listClips(req.params.projectId);
  if (clips.length === 0) { res.status(400).json({ error: "No clips in timeline" }); return; }

  const outputFile = `project_${req.params.projectId}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputFile);

  updateProject(req.params.username, req.params.projectId, { status: "exporting" });
  res.json({ status: "exporting" });

  try {
    const clipInputs = clips.map((c) => ({
      filePath: path.join(OUTPUT_DIR, c.filePath!),
      trimStart: c.trimStart,
      trimEnd: c.trimEnd > 0 ? c.trimEnd : (c.assetDuration ?? 0),
    }));

    await concatVideos({ clips: clipInputs, outputPath });

    updateProject(req.params.username, req.params.projectId, { status: "done", outputFile });

    // 把导出结果也加入素材库
    try {
      const dur = await getVideoDuration(outputPath);
      const asset = createAsset(uuidv4(), req.params.username, {
        name: `短片: ${project.name}`,
        filePath: outputFile,
        duration: dur,
        width: clips[0].width ?? 1280,
        height: clips[0].height ?? 720,
        fps: clips[0].fps ?? 30,
      });
    } catch {}
  } catch (err: any) {
    updateProject(req.params.username, req.params.projectId, { status: "error" });
    console.error("Export failed:", err);
  }
});

/**
 * GET /api/users/:username/projects/:projectId/download
 */
app.get("/api/users/:username/projects/:projectId/download", (req, res) => {
  const project = getProject(req.params.username, req.params.projectId);
  if (!project || !project.outputFile) { res.status(404).json({ error: "File not ready" }); return; }
  const filePath = path.join(OUTPUT_DIR, project.outputFile);
  if (!fs.existsSync(filePath)) { res.status(404).json({ error: "File not found" }); return; }
  res.download(filePath, `${project.name}.mp4`);
});

app.listen(PORT, () => {
  console.log(`MagicEffect backend running on http://localhost:${PORT}`);
});
