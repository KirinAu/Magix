## MagicEffect

MagicEffect 是一个用 AI 生成动画代码、实时预览并导出视频的小型工作台。

项目由两个主要部分组成：

- `frontend/`: Next.js 16 + React 19 前端，负责聊天、代码编辑、预览、渲染面板、素材库与时间线页面
- `backend/`: Express + TypeScript 后端，负责会话管理、SSE 流式聊天、代码渲染、视频编码、素材和项目存储

### 当前能力

- 通过用户名直接登录，不存在会自动创建
- 创建和保存 AI 动画会话
- 流式接收 Agent 输出、工具调用和调试事件
- 在浏览器内预览动画代码
- 发起渲染任务并导出 MP4
- 管理素材库和时间线项目
- 提供 Gemini `v1beta/models/*` 兼容转发接口

### 技术栈

- 前端: Next.js 16, React 19, TypeScript, Tailwind CSS, Monaco Editor
- 后端: Express 5, TypeScript, `@mariozechner/pi-coding-agent`
- 渲染与编码: Puppeteer, FFmpeg
- 数据存储: `better-sqlite3`
- 动画库: GSAP, Anime.js, PixiJS, Three.js, ECharts

### 目录结构

```text
.
├── backend/      # API、Agent、渲染与视频编码
├── frontend/     # Web UI、代理路由、时间线页面
├── docker-compose.deploy.yml
└── .env.deploy.example
```

### 本地开发

建议使用 Node.js 20。

1. 启动后端

```bash
cd backend
npm ci
npm run dev
```

默认后端端口是 `3001`。

2. 启动前端

```bash
cd frontend
npm ci
BACKEND_URL=http://localhost:3001 INTERNAL_API_BASE_URL=http://localhost:3001 npm run dev
```

默认前端端口是 `3000`。

3. 打开应用

```text
http://localhost:3000
```

### 运行要求

- 后端渲染依赖 Chromium 和 FFmpeg
- Docker 镜像已经在 `backend/Dockerfile` 中安装这些依赖
- 如果你直接在本机运行后端，需要确保系统里可用的 Chromium/Chrome 与 FFmpeg 已安装

### 关键接口

- `GET /api/config`: 读取当前 LLM 配置
- `PUT /api/config`: 更新 LLM 配置
- `POST /api/chat/start`: 启动聊天会话
- `POST /api/chat/:sessionId/message`: 发送消息并流式返回事件
- `POST /api/render`: 创建渲染任务
- `GET /api/render/:jobId`: 订阅渲染状态
- `GET /api/users/:username/sessions`: 会话列表
- `GET /api/users/:username/assets`: 素材列表
- `GET /api/users/:username/projects`: 项目列表

### 部署

仓库内提供了 Docker Compose 部署文件：`docker-compose.deploy.yml`。

常用环境变量示例见 `.env.deploy.example`：

- `REGISTRY`
- `IMAGE_NAMESPACE`
- `BACKEND_IMAGE_TAG`
- `FRONTEND_IMAGE_TAG`
- `WORKER_IMAGE_TAG`
- `DATABASE_URL`
- `REDIS_URL`
- `BACKEND_HOST_PORT`
- `FRONTEND_HOST_PORT`

### 备注

- `frontend/README.md` 仍然是 Next.js 初始化模板说明
- 当前仓库根目录原本没有项目级 README，这份文档用于补齐项目概览和启动说明
