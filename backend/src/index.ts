import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { createAnimationAgent, sendSSE, type LLMConfig } from "./agent";
import { renderFrames } from "./renderer";
import { encodeToMp4, cleanupFrames } from "./encoder";
import type { Agent } from "@mariozechner/pi-agent-core";
import {
  ensureUser,
  createSession,
  getSession,
  updateSession,
  deleteSession,
  listSessions,
  type ChatMessage as StoredMessage,
} from "./store";

interface Session {
  agent: Agent;
  setRes: (r: import("express").Response) => void;
  username: string;
  messages: StoredMessage[];
  currentCode: string;
  currentLibrary: string;
}

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "outputs");
const OUTPUT_DIR = path.join(DATA_DIR, "outputs");
const CONFIG_FILE = path.join(DATA_DIR, "llm_config.json");

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/outputs", express.static(OUTPUT_DIR));
app.use("/libs", express.static(path.join(process.cwd(), "libs")));

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

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
 * GET /api/users/:username/sessions/:sessionId
 * 获取会话详情（含消息）
 */
app.get("/api/users/:username/sessions/:sessionId", (req, res) => {
  const session = getSession(req.params.username, req.params.sessionId);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }
  res.json(session);
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

// ─── Agent 会话管理 ───────────────────────────────────────────────────────────

const sessions = new Map<string, Session>();

/**
 * POST /api/chat/start
 * 创建新的 Agent 会话，返回 sessionId
 * Body: LLMConfig + { username }
 */
app.post("/api/chat/start", (req, res) => {
  const { username, ...config } = req.body as LLMConfig & { username?: string };
  if (!config?.apiKey || !config?.modelId) {
    res.status(400).json({ error: "apiKey and modelId are required" });
    return;
  }

  const sessionId = uuidv4();
  const resolvedUsername = username?.trim().toLowerCase() || "anonymous";

  // 在 store 里创建持久化会话记录
  createSession(resolvedUsername, sessionId);

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Session-Id", sessionId);
  res.flushHeaders();

  const { agent, setRes } = createAnimationAgent(config, res);

  const memSession: Session = {
    agent,
    setRes,
    username: resolvedUsername,
    messages: [],
    currentCode: "",
    currentLibrary: "gsap",
  };
  sessions.set(sessionId, memSession);

  sendSSE(res, { type: "session_ready", sessionId });
  res.end();
});

/**
 * POST /api/chat/:sessionId/message
 * 向已有会话发送消息，SSE 流式返回
 * Body: { message, username? }
 */
app.post("/api/chat/:sessionId/message", async (req, res) => {
  const { sessionId } = req.params;
  const { message } = req.body;

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
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

        if (evt.type === "message_update") {
          const ae = evt.assistantMessageEvent;
          if (ae?.type === "text_delta") assistantBuffer += ae.delta;
          if (ae?.type === "toolcall_end") {
            const label = ae.toolName === "write_code" ? "生成代码"
              : ae.toolName === "str_replace" ? "修改代码"
              : ae.toolName === "read_code" ? "查看代码" : ae.toolName;
            session.messages.push({ role: "tool", content: label, toolName: ae.toolName, timestamp: Date.now() });
          }
        }

        if (evt.type === "turn_end") {
          const text = assistantBuffer.trim();
          if (text) {
            session.messages.push({ role: "assistant", content: text, timestamp: Date.now() });
          }
          assistantBuffer = "";
        }

        if (evt.type === "agent_end") {
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

  try {
    await session.agent.prompt(message);
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

interface RenderJob {
  status: "pending" | "rendering" | "encoding" | "done" | "error";
  progress: number;
  total: number;
  outputFile?: string;
  error?: string;
  username?: string;
  sessionId?: string;
}

const jobs = new Map<string, RenderJob>();

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
  const job: RenderJob = {
    status: "pending",
    progress: 0,
    total: Math.ceil(fps * duration),
    username,
    sessionId,
  };
  jobs.set(jobId, job);

  res.json({ jobId });

  const framesDir = path.join(OUTPUT_DIR, `frames_${jobId}`);
  const outputFile = path.join(OUTPUT_DIR, `${jobId}.mp4`);

  try {
    job.status = "rendering";

    await renderFrames(code, {
      library,
      fps,
      duration,
      width,
      height,
      outputDir: framesDir,
      onProgress: (frame, total) => {
        job.progress = frame;
        job.total = total;
      },
    });

    job.status = "encoding";

    await encodeToMp4({ framesDir, outputPath: outputFile, fps, width, height });

    cleanupFrames(framesDir);

    job.status = "done";
    job.outputFile = `${jobId}.mp4`;

    // 保存视频路径到会话
    if (username && sessionId) {
      updateSession(username, sessionId, { videoPath: `${jobId}.mp4` });
    }
  } catch (err: any) {
    job.status = "error";
    job.error = err.message;
    cleanupFrames(framesDir);
  }
});

/**
 * GET /api/render/:jobId  SSE 进度流
 */
app.get("/api/render/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const interval = setInterval(() => {
    sendSSE(res, {
      status: job.status,
      progress: job.progress,
      total: job.total,
      outputFile: job.outputFile,
      error: job.error,
    });

    if (job.status === "done" || job.status === "error") {
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
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done" || !job.outputFile) {
    res.status(404).json({ error: "File not ready" });
    return;
  }

  const filePath = path.join(OUTPUT_DIR, job.outputFile);
  res.download(filePath, "animation.mp4");
});

app.listen(PORT, () => {
  console.log(`MagicEffect backend running on http://localhost:${PORT}`);
});
