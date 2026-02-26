import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool, AgentEvent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Response } from "express";

export interface LLMConfig {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
}

const SYSTEM_PROMPT = `You are an expert animation developer. Write high-quality, creative animation code for a browser sandbox.

## Environment
- Code runs inside a \`<script>\` tag. Available libraries (choose the best fit):
  - **GSAP** (\`gsap\`) — DOM animation, timelines. Default choice.
  - **Anime.js** (\`anime\`) — lightweight GSAP alternative.
  - **PixiJS** (\`PIXI\`) — WebGL 2D. Use for large particle systems (1000+), sprites, filters. GSAP also available.
  - **Three.js** (\`THREE\`) — 3D scenes, PBR materials, shaders. GSAP also available.
  - **Canvas 2D** — always available via \`document.createElement('canvas')\`.
- No \`<script>\` tags, HTML, or import statements.
- Canvas size: \`window.CANVAS_WIDTH\` / \`window.CANVAS_HEIGHT\`. Never hardcode pixel values.
- Scale: \`window.SCALE\` = min(width/1280, height/720). Multiply all sizes by it.
- Black background. Use the full canvas. Animations must loop or have a clear duration.
- **PixiJS**: \`new PIXI.Application({width, height, backgroundColor:0})\`, append \`app.view\`. Ticker is auto-stopped — drive properties via GSAP timelines.
- **Three.js**: Use a RAF loop for rendering (intercepted for seek). **NEVER use \`gsap.ticker.add()\`** — it is not intercepted and produces black frames on export.
- **Canvas 2D**: Use RAF loop.

## Cleanup (always first)
\`\`\`js
gsap.killTweensOf("*"); gsap.globalTimeline.clear();
if (window.__rafId) cancelAnimationFrame(window.__rafId);
if (window.__pixiApp) { window.__pixiApp.destroy(true); window.__pixiApp = null; }
if (window.__threeRenderer) { window.__threeRenderer.dispose(); window.__threeRenderer = null; }
document.querySelectorAll('canvas, .anim-el').forEach(el => el.remove());
\`\`\`

## Tools
- **read_code()** — read current code before str_replace.
- **write_code(code, library, description)** — full write or rewrite. \`library\`: \`"gsap"\`/\`"anime"\`/\`"pixi"\`/\`"three"\`.
- **str_replace(old_str, new_str, description)** — targeted edit. \`old_str\` must be unique and exact.

## Workflow
**IMPORTANT: Always follow these steps in order. Do NOT call any tool until Step 1 is complete.**

### Step 1 — Analyze (text only, no tool calls)
Before writing any code, output a short analysis in plain text:
- **Intent**: What is the user really asking for? What mood, style, feeling?
- **Library**: Which library and why?
- **Concept**: Core visual idea in one sentence.
- **Color**: Palette (max 3 colors).
- **Motion**: Key motion beats — what moves, when, how fast?

### Step 2 — Write
Call \`write_code\` with the full implementation. Start the code with a one-line comment summarizing the brief.

### Step 3 — Review
After writing, check: syntax errors? undefined variables? CANVAS_WIDTH/HEIGHT used? cleanup block present? loops correctly? Three.js uses RAF (not gsap.ticker)?

### Step 4 — Fix
If issues found, fix immediately with \`str_replace\`.

### Step 5 — Summarize
Short reply: what was built + recommended loop duration.

## Visual quality
- **Aesthetic**: Apple keynote / Stripe / Nike — not CodePen demos.
- **Color**: 1–3 colors max. Black bg + one accent. Monochrome + accent > rainbow.
- **Composition**: clear focal point, rule of thirds or dead center, intentional negative space.
- **Motion**: intro → hold → outro. Stagger 0.05–0.15s. Mix fast snaps (0.2–0.4s) with slow drifts (2–4s). No linear easing.
- **Depth**: background (low opacity, slow), midground, foreground (full opacity). CSS blur on bg elements.
- **Restraint**: one idea, executed with precision. When in doubt, remove an element.

Respond in the same language the user writes in.`;


function buildModel(config: LLMConfig): Model<any> {
  const isAnthropic = config.provider === "anthropic";
  const api = isAnthropic ? "anthropic-messages" : "openai-completions";

  return {
    id: config.modelId,
    name: config.modelId,
    api,
    provider: config.provider,
    baseUrl: config.baseUrl ?? (isAnthropic
      ? "https://api.anthropic.com"
      : "https://api.openai.com"),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
}

export function createAnimationAgent(
  config: LLMConfig,
  initialRes: Response
): { agent: Agent; setRes: (r: Response) => void } {
  // 维护当前代码状态（session 级别）
  let currentCode = "";
  let currentLibrary = "gsap";
  let res = initialRes;

  const readCodeTool: AgentTool<any> = {
    name: "read_code",
    label: "Read Current Code",
    description: "Returns the current animation code. Use this before str_replace to verify the exact content.",
    parameters: Type.Object({}),
    execute: async () => {
      return {
        content: [{ type: "text" as const, text: currentCode ? `Current code:\n\`\`\`js\n${currentCode}\n\`\`\`` : "No code written yet." }],
        details: { code: currentCode },
      };
    },
  };

  const writeCodeTool: AgentTool<any> = {
    name: "write_code",
    label: "Write Animation Code",
    description: "Output the complete animation code. Use for initial generation or full rewrites.",
    parameters: Type.Object({
      code: Type.String({ description: "Complete animation JavaScript code" }),
      library: Type.Union(
        [Type.Literal("gsap"), Type.Literal("anime"), Type.Literal("pixi"), Type.Literal("three")],
        { description: "Which animation library this code uses" }
      ),
      description: Type.String({ description: "Brief description of what this animation does" }),
    }),
    execute: async (_toolCallId, params) => {
      currentCode = params.code;
      currentLibrary = params.library;
      // 通知前端完整代码（toolcall_delta 已经流式更新了，这里做最终确认）
      sendSSE(res, {
        type: "code_update",
        code: params.code,
        library: params.library,
        mode: "full",
      });
      return {
        content: [{ type: "text" as const, text: `Code written (${params.code.split("\n").length} lines): ${params.description}\n\nNow review the code: check for syntax errors, undefined variables, missing loop/duration, and whether it matches the user's request. If anything is wrong, fix it with str_replace immediately.` }],
        details: params,
      };
    },
  };

  const strReplaceTool: AgentTool<any> = {
    name: "str_replace",
    label: "Edit Code",
    description: "Replace an exact substring in the current code. Use for targeted edits.",
    parameters: Type.Object({
      old_str: Type.String({ description: "Exact string to find and replace (must be unique in the code)" }),
      new_str: Type.String({ description: "Replacement string" }),
      description: Type.String({ description: "Brief description of what this change does" }),
    }),
    execute: async (_toolCallId, params) => {
      if (!currentCode) {
        throw new Error("No code exists yet. Use write_code first.");
      }

      const count = currentCode.split(params.old_str).length - 1;
      if (count === 0) {
        throw new Error(`old_str not found in current code. Make sure it matches exactly.`);
      }
      if (count > 1) {
        throw new Error(`old_str matches ${count} times. Provide a more unique string.`);
      }

      currentCode = currentCode.replace(params.old_str, params.new_str);

      sendSSE(res, {
        type: "code_update",
        code: currentCode,
        library: currentLibrary,
        mode: "patch",
      });

      return {
        content: [{ type: "text" as const, text: `Applied edit: ${params.description}` }],
        details: { ...params, resultCode: currentCode },
      };
    },
  };

  const model = buildModel(config);

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: [readCodeTool, writeCodeTool, strReplaceTool],
    },
    getApiKey: () => config.apiKey,
  });

  agent.subscribe((event: AgentEvent) => {
    // 如果是错误结束，提取错误信息发给前端
    if (event.type === "agent_end") {
      const lastMsg = event.messages[event.messages.length - 1] as any;
      if (lastMsg?.stopReason === "error") {
        console.error("[agent_end error] lastMsg:", JSON.stringify(lastMsg, null, 2));
        const errText = lastMsg.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("") || "请求失败";
        sendSSE(res, { type: "error", message: errText });
      }
    }
    sendSSE(res, event);
    if (event.type === "agent_end" && !res.writableEnded) {
      res.end();
    }
  });

  return { agent, setRes: (r: Response) => { res = r; } };
}

export function sendSSE(res: Response, data: unknown): void {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
