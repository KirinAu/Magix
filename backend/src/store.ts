import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// ─── 数据模型 ───────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "thinking";
  content: string;
  toolName?: string;
  timestamp: number;
}

export interface UserSession {
  sessionId: string;
  title: string;
  messages: ChatMessage[];
  code: string;
  library: string;
  videoPath: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UserData {
  username: string;
  createdAt: number;
  sessions: UserSession[];
}

// ─── 数据库初始化 ────────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "outputs");
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "magiceffect.db");
const db = new Database(DB_PATH);

// WAL 模式提升并发读性能
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username   TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id  TEXT PRIMARY KEY,
    username    TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT '新会话',
    code        TEXT NOT NULL DEFAULT '',
    library     TEXT NOT NULL DEFAULT 'gsap',
    video_path  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    tool_name   TEXT,
    timestamp   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

  CREATE TABLE IF NOT EXISTS render_jobs (
    job_id      TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    username    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    progress    INTEGER NOT NULL DEFAULT 0,
    total       INTEGER NOT NULL DEFAULT 0,
    output_file TEXT,
    error       TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_render_jobs_session ON render_jobs(session_id);

  -- 素材库（已渲染完成的视频自动入库）
  CREATE TABLE IF NOT EXISTS assets (
    asset_id    TEXT PRIMARY KEY,
    username    TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    duration    REAL NOT NULL DEFAULT 0,
    width       INTEGER NOT NULL DEFAULT 1280,
    height      INTEGER NOT NULL DEFAULT 720,
    fps         INTEGER NOT NULL DEFAULT 30,
    thumbnail   TEXT,
    source_session_id TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assets_username ON assets(username);

  -- 短片项目
  CREATE TABLE IF NOT EXISTS projects (
    project_id  TEXT PRIMARY KEY,
    username    TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    name        TEXT NOT NULL DEFAULT '未命名短片',
    status      TEXT NOT NULL DEFAULT 'draft',
    output_file TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_projects_username ON projects(username);

  -- 时间线片段
  CREATE TABLE IF NOT EXISTS clips (
    clip_id     TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    asset_id    TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    position    INTEGER NOT NULL DEFAULT 0,
    trim_start  REAL NOT NULL DEFAULT 0,
    trim_end    REAL NOT NULL DEFAULT -1,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_clips_project ON clips(project_id);
`);

// ─── 预编译语句 ──────────────────────────────────────────────────────────────

const stmts = {
  getUser:        db.prepare("SELECT * FROM users WHERE username = ?"),
  insertUser:     db.prepare("INSERT OR IGNORE INTO users (username, created_at) VALUES (?, ?)"),
  insertSession:  db.prepare("INSERT INTO sessions (session_id, username, created_at, updated_at) VALUES (?, ?, ?, ?)"),
  getSession:     db.prepare("SELECT * FROM sessions WHERE username = ? AND session_id = ?"),
  listSessions:   db.prepare("SELECT session_id, username, title, code, library, video_path, created_at, updated_at FROM sessions WHERE username = ? ORDER BY updated_at DESC"),
  updateSession:  db.prepare("UPDATE sessions SET title=?, code=?, library=?, video_path=?, updated_at=? WHERE username=? AND session_id=?"),
  deleteSession:  db.prepare("DELETE FROM sessions WHERE username = ? AND session_id = ?"),
  insertMessage:  db.prepare("INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?, ?, ?, ?, ?)"),
  getMessages:    db.prepare("SELECT role, content, tool_name, timestamp FROM messages WHERE session_id = ? ORDER BY id ASC"),
  deleteMessages: db.prepare("DELETE FROM messages WHERE session_id = ?"),
  // render jobs
  insertRenderJob:  db.prepare("INSERT INTO render_jobs (job_id, session_id, username, status, progress, total, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)"),
  updateRenderJob:  db.prepare("UPDATE render_jobs SET status=?, progress=?, total=?, output_file=?, error=?, updated_at=? WHERE job_id=?"),
  getRenderJob:     db.prepare("SELECT * FROM render_jobs WHERE job_id = ?"),
  getSessionRenderJob: db.prepare("SELECT * FROM render_jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1"),

  // assets
  insertAsset:   db.prepare("INSERT INTO assets (asset_id, username, name, file_path, duration, width, height, fps, thumbnail, source_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  getAsset:      db.prepare("SELECT * FROM assets WHERE asset_id = ?"),
  listAssets:    db.prepare("SELECT * FROM assets WHERE username = ? ORDER BY created_at DESC"),
  deleteAsset:   db.prepare("DELETE FROM assets WHERE asset_id = ? AND username = ?"),
  updateAsset:   db.prepare("UPDATE assets SET name = ? WHERE asset_id = ? AND username = ?"),

  // projects
  insertProject: db.prepare("INSERT INTO projects (project_id, username, name, status, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?)"),
  getProject:    db.prepare("SELECT * FROM projects WHERE project_id = ? AND username = ?"),
  listProjects:  db.prepare("SELECT * FROM projects WHERE username = ? ORDER BY updated_at DESC"),
  updateProject: db.prepare("UPDATE projects SET name=?, status=?, output_file=?, updated_at=? WHERE project_id=? AND username=?"),
  deleteProject: db.prepare("DELETE FROM projects WHERE project_id = ? AND username = ?"),

  // clips
  insertClip:    db.prepare("INSERT INTO clips (clip_id, project_id, asset_id, position, trim_start, trim_end, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  listClips:     db.prepare("SELECT c.*, a.file_path, a.name as asset_name, a.duration as asset_duration, a.width, a.height, a.fps FROM clips c JOIN assets a ON c.asset_id = a.asset_id WHERE c.project_id = ? ORDER BY c.position ASC"),
  deleteClip:    db.prepare("DELETE FROM clips WHERE clip_id = ? AND project_id = ?"),
  updateClip:    db.prepare("UPDATE clips SET position=?, trim_start=?, trim_end=? WHERE clip_id=?"),
  deleteClipsByProject: db.prepare("DELETE FROM clips WHERE project_id = ?"),
};

// ─── 用户操作 ────────────────────────────────────────────────────────────────

export function ensureUser(username: string): UserData {
  const now = Date.now();
  stmts.insertUser.run(username, now);
  const row = stmts.getUser.get(username) as { username: string; created_at: number };
  return {
    username: row.username,
    createdAt: row.created_at,
    sessions: [],
  };
}

export function getUser(username: string): UserData | null {
  const row = stmts.getUser.get(username) as { username: string; created_at: number } | undefined;
  if (!row) return null;
  return { username: row.username, createdAt: row.created_at, sessions: [] };
}

// ─── 会话操作 ────────────────────────────────────────────────────────────────

export function createSession(username: string, sessionId: string): UserSession {
  ensureUser(username);
  const now = Date.now();
  stmts.insertSession.run(sessionId, username, now, now);
  return {
    sessionId,
    title: "新会话",
    messages: [],
    code: "",
    library: "gsap",
    videoPath: null,
    createdAt: now,
    updatedAt: now,
  };
}

function rowToSession(row: any, withMessages = false): UserSession {
  const messages: ChatMessage[] = withMessages
    ? (stmts.getMessages.all(row.session_id) as any[]).map((m) => ({
        role: m.role,
        content: m.content,
        toolName: m.tool_name ?? undefined,
        timestamp: m.timestamp,
      }))
    : [];
  return {
    sessionId: row.session_id,
    title: row.title,
    messages,
    code: row.code,
    library: row.library,
    videoPath: row.video_path ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getSession(username: string, sessionId: string): UserSession | null {
  const row = stmts.getSession.get(username, sessionId);
  if (!row) return null;
  return rowToSession(row, true);
}

export function updateSession(
  username: string,
  sessionId: string,
  patch: Partial<Pick<UserSession, "title" | "messages" | "code" | "library" | "videoPath">>
): UserSession | null {
  const row = stmts.getSession.get(username, sessionId) as any;
  if (!row) return null;

  const title     = patch.title     ?? row.title;
  const code      = patch.code      ?? row.code;
  const library   = patch.library   ?? row.library;
  const videoPath = patch.videoPath !== undefined ? patch.videoPath : row.video_path;
  const now       = Date.now();

  stmts.updateSession.run(title, code, library, videoPath, now, username, sessionId);

  // 如果传了 messages，整体替换
  if (patch.messages !== undefined) {
    const replaceMessages = db.transaction((msgs: ChatMessage[]) => {
      stmts.deleteMessages.run(sessionId);
      for (const m of msgs) {
        stmts.insertMessage.run(sessionId, m.role, m.content, m.toolName ?? null, m.timestamp);
      }
    });
    replaceMessages(patch.messages);
  }

  return getSession(username, sessionId);
}

export function deleteSession(username: string, sessionId: string): boolean {
  const result = stmts.deleteSession.run(username, sessionId);
  return result.changes > 0;
}

export function listSessions(username: string): Omit<UserSession, "messages">[] {
  const rows = stmts.listSessions.all(username) as any[];
  return rows.map((r) => rowToSession(r, false));
}

// ─── 渲染 Job 操作 ────────────────────────────────────────────────────────────

export interface RenderJobRecord {
  jobId: string;
  sessionId: string;
  username: string;
  status: "pending" | "rendering" | "encoding" | "done" | "error" | "stopped";
  progress: number;
  total: number;
  outputFile?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

function rowToRenderJob(row: any): RenderJobRecord {
  return {
    jobId: row.job_id,
    sessionId: row.session_id,
    username: row.username,
    status: row.status,
    progress: row.progress,
    total: row.total,
    outputFile: row.output_file ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createRenderJob(jobId: string, sessionId: string, username: string, total: number): RenderJobRecord {
  const now = Date.now();
  stmts.insertRenderJob.run(jobId, sessionId, username, total, now, now);
  return { jobId, sessionId, username, status: "pending", progress: 0, total, createdAt: now, updatedAt: now };
}

export function updateRenderJob(
  jobId: string,
  patch: Partial<Pick<RenderJobRecord, "status" | "progress" | "total" | "outputFile" | "error">>
): void {
  const row = stmts.getRenderJob.get(jobId) as any;
  if (!row) return;
  stmts.updateRenderJob.run(
    patch.status ?? row.status,
    patch.progress ?? row.progress,
    patch.total ?? row.total,
    patch.outputFile ?? row.output_file ?? null,
    patch.error ?? row.error ?? null,
    Date.now(),
    jobId
  );
}

export function getRenderJob(jobId: string): RenderJobRecord | null {
  const row = stmts.getRenderJob.get(jobId);
  if (!row) return null;
  return rowToRenderJob(row);
}

export function getSessionRenderJob(sessionId: string): RenderJobRecord | null {
  const row = stmts.getSessionRenderJob.get(sessionId);
  if (!row) return null;
  return rowToRenderJob(row);
}

// ─── 素材库 ───────────────────────────────────────────────────────────────────

export interface AssetRecord {
  assetId: string;
  username: string;
  name: string;
  filePath: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  thumbnail?: string;
  sourceSessionId?: string;
  createdAt: number;
}

function rowToAsset(row: any): AssetRecord {
  return {
    assetId: row.asset_id,
    username: row.username,
    name: row.name,
    filePath: row.file_path,
    duration: row.duration,
    width: row.width,
    height: row.height,
    fps: row.fps,
    thumbnail: row.thumbnail ?? undefined,
    sourceSessionId: row.source_session_id ?? undefined,
    createdAt: row.created_at,
  };
}

export function createAsset(assetId: string, username: string, data: {
  name: string; filePath: string; duration: number;
  width: number; height: number; fps: number;
  thumbnail?: string; sourceSessionId?: string;
}): AssetRecord {
  const now = Date.now();
  stmts.insertAsset.run(assetId, username, data.name, data.filePath, data.duration, data.width, data.height, data.fps, data.thumbnail ?? null, data.sourceSessionId ?? null, now);
  return { assetId, username, createdAt: now, ...data };
}

export function getAsset(assetId: string): AssetRecord | null {
  const row = stmts.getAsset.get(assetId);
  if (!row) return null;
  return rowToAsset(row);
}

export function listAssets(username: string): AssetRecord[] {
  return (stmts.listAssets.all(username) as any[]).map(rowToAsset);
}

export function deleteAsset(assetId: string, username: string): boolean {
  // 获取文件路径，删除磁盘文件
  const asset = getAsset(assetId);
  if (asset && asset.username === username) {
    const filePath = path.join(DATA_DIR, "outputs", asset.filePath);
    try { fs.unlinkSync(filePath); } catch {}
  }
  return stmts.deleteAsset.run(assetId, username).changes > 0;
}

export function renameAsset(assetId: string, username: string, name: string): boolean {
  return stmts.updateAsset.run(name, assetId, username).changes > 0;
}

// ─── 短片项目 ─────────────────────────────────────────────────────────────────

export interface ProjectRecord {
  projectId: string;
  username: string;
  name: string;
  status: "draft" | "exporting" | "done" | "error";
  outputFile?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ClipRecord {
  clipId: string;
  projectId: string;
  assetId: string;
  position: number;
  trimStart: number;
  trimEnd: number;
  filePath?: string;
  assetName?: string;
  assetDuration?: number;
  width?: number;
  height?: number;
  fps?: number;
  createdAt: number;
}

function rowToProject(row: any): ProjectRecord {
  return {
    projectId: row.project_id,
    username: row.username,
    name: row.name,
    status: row.status,
    outputFile: row.output_file ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToClip(row: any): ClipRecord {
  return {
    clipId: row.clip_id,
    projectId: row.project_id,
    assetId: row.asset_id,
    position: row.position,
    trimStart: row.trim_start,
    trimEnd: row.trim_end,
    filePath: row.file_path ?? undefined,
    assetName: row.asset_name ?? undefined,
    assetDuration: row.asset_duration ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    fps: row.fps ?? undefined,
    createdAt: row.created_at,
  };
}

export function createProject(projectId: string, username: string, name: string): ProjectRecord {
  const now = Date.now();
  stmts.insertProject.run(projectId, username, name, now, now);
  return { projectId, username, name, status: "draft", createdAt: now, updatedAt: now };
}

export function getProject(username: string, projectId: string): ProjectRecord | null {
  const row = stmts.getProject.get(projectId, username);
  if (!row) return null;
  return rowToProject(row);
}

export function listProjects(username: string): ProjectRecord[] {
  return (stmts.listProjects.all(username) as any[]).map(rowToProject);
}

export function updateProject(username: string, projectId: string, patch: Partial<Pick<ProjectRecord, "name" | "status" | "outputFile">>): boolean {
  const row = stmts.getProject.get(projectId, username) as any;
  if (!row) return false;
  stmts.updateProject.run(
    patch.name ?? row.name,
    patch.status ?? row.status,
    patch.outputFile ?? row.output_file ?? null,
    Date.now(),
    projectId,
    username
  );
  return true;
}

export function deleteProject(username: string, projectId: string): boolean {
  return stmts.deleteProject.run(projectId, username).changes > 0;
}

// ─── 时间线片段 ───────────────────────────────────────────────────────────────

export function addClip(clipId: string, projectId: string, assetId: string, position: number, trimStart: number, trimEnd: number): ClipRecord {
  const now = Date.now();
  stmts.insertClip.run(clipId, projectId, assetId, position, trimStart, trimEnd, now);
  return { clipId, projectId, assetId, position, trimStart, trimEnd, createdAt: now };
}

export function listClips(projectId: string): ClipRecord[] {
  return (stmts.listClips.all(projectId) as any[]).map(rowToClip);
}

export function removeClip(clipId: string, projectId: string): boolean {
  return stmts.deleteClip.run(clipId, projectId).changes > 0;
}

export function updateClip(clipId: string, patch: { position?: number; trimStart?: number; trimEnd?: number }): boolean {
  const row = db.prepare("SELECT * FROM clips WHERE clip_id = ?").get(clipId) as any;
  if (!row) return false;
  stmts.updateClip.run(
    patch.position ?? row.position,
    patch.trimStart ?? row.trim_start,
    patch.trimEnd ?? row.trim_end,
    clipId
  );
  return true;
}

export function replaceClips(projectId: string, clips: Array<{ clipId: string; assetId: string; position: number; trimStart: number; trimEnd: number }>): void {
  const tx = db.transaction(() => {
    stmts.deleteClipsByProject.run(projectId);
    const now = Date.now();
    for (const c of clips) {
      stmts.insertClip.run(c.clipId, projectId, c.assetId, c.position, c.trimStart, c.trimEnd, now);
    }
  });
  tx();
}
