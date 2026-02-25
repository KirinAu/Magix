import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { createAnimationAgent, sendSSE, type LLMConfig } from "./agent";
import { renderFrames } from "./renderer";
import { encodeToMp4, cleanupFrames } from "./encoder";
import type { Agent } from "@mariozechner/pi-agent-core";

interface Session {
  agent: Agent;
  setRes: (r: import("express").Response) => void;
}

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "outputs");
const OUTPUT_DIR = path.join(DATA_DIR, "outputs");
const CONFIG_FILE = path.join(DATA_DIR, "llm_config.json");

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/outputs", express.static(OUTPUT_DIR));

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

// ─── Agent 会话管理 ───────────────────────────────────────────────────────────
// sessionId → Agent 实例（简单内存存储，MVP 够用）
const sessions = new Map<string, Session>();

/**
 * POST /api/chat/start
 * 创建新的 Agent 会话，返回 sessionId
 */
app.post("/api/chat/start", (req, res) => {
  const config: LLMConfig = req.body;
  if (!config?.apiKey || !config?.modelId) {
    res.status(400).json({ error: "apiKey and modelId are required" });
    return;
  }

  const sessionId = uuidv4();

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Session-Id", sessionId);
  res.flushHeaders();

  const { agent, setRes } = createAnimationAgent(config, res);
  sessions.set(sessionId, { agent, setRes });

  // 发送 session_ready 事件后关闭连接（sessionId 已通过事件传递）
  sendSSE(res, { type: "session_ready", sessionId });
  res.end();
});

/**
 * POST /api/chat/:sessionId/message
 * 向已有会话发送消息，SSE 流式返回
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

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // 把当前 response 绑定到 agent，工具里的 sendSSE 会写到这里
  session.setRes(res);

  session.agent.subscribe((event) => {
    sendSSE(res, event);
    if (event.type === "agent_end") {
      res.end();
    }
  });

  try {
    await session.agent.prompt(message);
  } catch (err: any) {
    sendSSE(res, { type: "error", message: err.message });
    res.end();
  }
});

/**
 * DELETE /api/chat/:sessionId
 * 清理会话
 */
app.delete("/api/chat/:sessionId", (req, res) => {
  sessions.delete(req.params.sessionId);
  res.json({ ok: true });
});

/**
 * POST /api/chat/:sessionId/abort
 * 中止当前正在运行的 agent
 */
app.post("/api/chat/:sessionId/abort", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }
  session.agent.abort();
  res.json({ ok: true });
});

// ─── 渲染 ─────────────────────────────────────────────────────────────────────

interface RenderJob {
  status: "pending" | "rendering" | "encoding" | "done" | "error";
  progress: number;
  total: number;
  outputFile?: string;
  error?: string;
}

const jobs = new Map<string, RenderJob>();

/**
 * POST /api/render
 * 提交渲染任务
 * Body: { code, library, fps, duration, width, height }
 */
app.post("/api/render", async (req, res) => {
  const { code, library = "auto", fps = 30, duration = 3, width = 1280, height = 720 } = req.body;

  if (!code) {
    res.status(400).json({ error: "code is required" });
    return;
  }

  const jobId = uuidv4();
  const job: RenderJob = { status: "pending", progress: 0, total: Math.ceil(fps * duration) };
  jobs.set(jobId, job);

  res.json({ jobId });

  // 异步执行渲染
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
  } catch (err: any) {
    job.status = "error";
    job.error = err.message;
    cleanupFrames(framesDir);
  }
});

/**
 * GET /api/render/:jobId
 * SSE 进度流
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
 * 下载 MP4
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
