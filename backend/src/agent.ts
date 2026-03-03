import type { AgentSessionEvent, ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Response } from "express";
import { validateCode } from "./validator";

// 用 new Function 绕过 tsc 把 import() 编译成 require() 的问题
async function loadCodingAgent() {
  // eslint-disable-next-line no-new-func
  const mod = await (new Function('return import("@mariozechner/pi-coding-agent")')() as Promise<typeof import("@mariozechner/pi-coding-agent")>);
  return mod;
}

export interface LLMConfig {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  stripThinking?: boolean;
}

const SYSTEM_PROMPT = `You are an expert animation developer. Write high-quality, creative animation code for a browser sandbox.

## Environment
- Code runs inside a \`<script>\` tag. Available libraries (choose the best fit):
  - **GSAP** (\`gsap\`) — DOM animation, timelines. Default choice.
  - **Anime.js** (\`anime\`) — lightweight GSAP alternative.
  - **PixiJS** (\`PIXI\`) — WebGL 2D. Use for large particle systems (1000+), sprites, filters. GSAP also available.
  - **Three.js** (\`THREE\`) — 3D scenes, PBR materials, shaders. GSAP also available.
  - **ECharts** (\`echarts\`) — data visualisation, animated charts (bar, line, pie, radar, graph, etc.). GSAP also available.
  - **Canvas 2D** — always available via \`document.createElement('canvas')\`.
- No \`<script>\` tags, HTML, or import statements.
- Canvas size: \`window.CANVAS_WIDTH\` / \`window.CANVAS_HEIGHT\`. Never hardcode absolute position/sizes! Use dynamic sizing.
- **CRITICAL SCALE RULE**: \`window.SCALE\` = min(width/1280, height/720). **You MUST multiply all absolute sizes, fonts, strokes, and line widths by \`window.SCALE\` so the animation does not become tiny on large 4K screens.**
- Example: \`const radius = 50 * window.SCALE;\`
- Example coords: \`x: window.CANVAS_WIDTH * 0.5\` (always use percentages of total width/height for positions).
- Black background. Use the full canvas. Animations must loop or have a clear duration.
- **PixiJS**: \`new PIXI.Application({width, height, backgroundColor:0})\`, append \`app.view\`. Ticker is auto-stopped — drive properties via GSAP timelines.
- **Three.js**: Use a RAF loop for rendering (intercepted for seek). **NEVER use \`gsap.ticker.add()\`** — it is not intercepted and produces black frames on export.
- **Canvas 2D**: Use RAF loop.
- **ECharts**: Create a \`<div>\` with CANVAS_WIDTH×CANVAS_HEIGHT, call \`echarts.init(div)\` → \`chart.setOption(...)\`. Use GSAP or RAF to animate option updates. Store instance on \`window.__echartsInstance\`.

## Cleanup (always first)
\`\`\`js
gsap.killTweensOf("*"); gsap.globalTimeline.clear();
if (window.__rafId) cancelAnimationFrame(window.__rafId);
if (window.__pixiApp) { window.__pixiApp.destroy(true); window.__pixiApp = null; }
if (window.__threeRenderer) { window.__threeRenderer.dispose(); window.__threeRenderer = null; }
if (window.__echartsInstance) { window.__echartsInstance.dispose(); window.__echartsInstance = null; }
document.querySelectorAll('canvas, .anim-el').forEach(el => el.remove());
\`\`\`

## Tools
**IMPORTANT: Call only ONE tool at a time. Wait for the result before calling the next tool.**
- **read_code()** — read current committed code before str_replace.
- **commit_code(code, library, description)** — commits code AND automatically runs validation. Returns commit status + full validation results (ok, errors, warnings) in one step. \`library\` must be one of: \`gsap\`, \`anime\`, \`pixi\`, \`three\`, \`canvas\`.
- **str_replace(old_str, new_str, description)** — targeted edit on committed code, then automatically validates. Returns edit status + validation results.
- **validate_code()** — explicitly re-run validation on current code when needed.

## Tool call style (MANDATORY)
Before every \`commit_code\` or \`str_replace\` call, output one short sentence to the user first (<= 20 words) saying what you are about to change, then call the tool.
Example: "我先微调曲线路径与像素端点对齐。"
If \`str_replace\` fails with "old_str not found", call \`read_code()\` and retry with exact text from current code.

## Handling user feedback
**If the user reports a runtime error or visual problem (e.g. "X is not defined", "it doesn't work", "wrong shape"):**
1. Call \`read_code()\` to get the current code.
2. Fix the issue with \`str_replace\` or \`commit_code\` (validation runs automatically).
3. If the result shows errors, fix again. If ok=true, write a reply.
**NEVER skip reading the code before editing.**

**If the user asks to modify, adjust, or improve existing code (e.g. "改一下这个", "优化这个动画", "加个XX效果", "基于这个代码"):**
1. **ALWAYS call \`read_code()\` first** to see the current code.
2. Then use \`str_replace\` to make targeted changes.
3. If the user's request is vague, read the code first to understand what exists, then ask clarifying questions or make reasonable improvements.

**Key principle: When in doubt, read first, then edit.**

## Workflow
**IMPORTANT: Follow these steps in strict order.**

### Step 1 — Analyze (text only, no tool calls)
Output a short analysis in plain text:
- **Intent**: What is the user really asking for? What mood, style, feeling?
- **Library**: Which library and why?
- **Concept**: Core visual idea in one sentence.
- **Color**: Palette (max 3 colors).
- **Motion**: Key motion beats — what moves, when, how fast?

### Step 2 — Commit Code
Call \`commit_code(code, library, description)\`. Validation runs automatically and results are returned.

### Step 3 — Fix if needed
If the result contains errors or warnings: call \`read_code()\`, fix with \`str_replace\` (auto-validates). Repeat until ok=true with no warnings. Max 5 rounds.

### Step 3.5 — Self-Review (MANDATORY before final summary)
When \`ok=true\` and no warnings:
1. Call \`read_code()\` and review the code quality once.
2. If you find any weakness (readability, visual polish, performance, scaling, cleanup, timing), fix it with \`str_replace\`.
3. Re-check using \`validate_code()\` if you made edits.
4. Repeat this self-review loop up to 2 rounds, then continue.

### Step 4 — Final Summary (MANDATORY — DO NOT SKIP)
**You MUST output a final text summary to the user.**
Your summary must include:
- What was built
- Which library was used
- **Estimated loop duration in seconds** (required, e.g. \`Loop: ~3.2s\`)

## CRITICAL: Tool Response Handling
When you receive the result of \`commit_code\` or \`str_replace\`, **DO NOT STOP**.
- If the result says "There are errors", you MUST continue by generating a text plan and then calling \`read_code()\`.
- If the result says "ok=true", you MUST run Step 3.5 self-review, then output the Step 4 final text summary.
**Stopping directly after receiving a tool result is STRICTLY FORBIDDEN.**
If you have not produced the final text summary yet, the task is NOT complete.

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
  const isGoogle = config.provider === "google";
  const api = isAnthropic
    ? "anthropic-messages"
    : isGoogle
      ? "google-generative-ai"
      : "openai-completions";

  const isThinkingModel = /claude-3[-.]?[57]|claude-sonnet-4|gemini-2\.5|o[134]|deepseek-r|qwq/i.test(config.modelId);

  return {
    id: config.modelId,
    name: config.modelId,
    api,
    provider: config.provider,
    baseUrl: config.baseUrl ?? (isAnthropic
      ? "https://api.anthropic.com"
      : isGoogle
        ? "https://generativelanguage.googleapis.com/v1beta"
        : "https://api.openai.com"),
    reasoning: isThinkingModel,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
}


export async function createAnimationAgent(
  config: LLMConfig,
  initialRes: Response,
  options?: {
    sessionManager?: any;
    initialCode?: string;
    initialLibrary?: string;
  }
): Promise<{ session: any; setRes: (r: Response) => void }> {
  let currentCode = options?.initialCode ?? "";
  let currentLibrary = options?.initialLibrary ?? "gsap";
  let res = initialRes;

  const readCodeTool: ToolDefinition<any> = {
    name: "read_code",
    label: "Read Current Code",
    description: "Returns the current animation code. Use this before str_replace to verify the exact content.",
    parameters: Type.Object({}),
    execute: async () => {
      const readResult = currentCode ? `Current code:\n\`\`\`js\n${currentCode}\n\`\`\`` : "No code written yet.";
      const summary = currentCode ? `(${currentCode.split("\n").length} lines returned)` : "No code written yet.";
      sendSSE(res, { type: "tool_result_debug", toolName: "read_code", result: summary });
      return {
        content: [{ type: "text" as const, text: readResult }],
        details: { code: currentCode },
      };
    },
  };

  const commitCodeTool: ToolDefinition<any> = {
    name: "commit_code",
    label: "Commit Draft Code",
    description: "Commit JavaScript animation code and automatically validate it. Returns commit status + validation results (ok, errors, warnings) in one step.",
    parameters: Type.Object({
      code: Type.String({ description: "The complete JavaScript animation code to commit" }),
      library: Type.Unsafe<"gsap" | "anime" | "pixi" | "three" | "echarts" | "canvas">({
        type: "string",
        enum: ["gsap", "anime", "pixi", "three", "echarts", "canvas"],
        description: "Which animation library this code uses",
      }),
      description: Type.String({ description: "Brief description of this committed code" }),
    }),
    execute: async (_toolCallId, params) => {
      const code = params.code?.trim();
      if (!code) {
        throw new Error("code parameter is required and must not be empty.");
      }
      currentCode = code;
      currentLibrary = params.library;
      sendSSE(res, {
        type: "code_update",
        code: currentCode,
        library: params.library,
        mode: "full",
      });

      // Auto-validate
      const validation = await validateCode(currentCode, currentLibrary);
      const parts: string[] = [`Code committed (${currentCode.split("\n").length} lines): ${params.description}.`];
      parts.push(`\nValidation — ok: ${validation.ok}`);
      if (validation.errors.length) parts.push(`errors:\n${validation.errors.map((e: string) => `  - ${e}`).join("\n")}`);
      if (validation.warnings.length) parts.push(`warnings:\n${validation.warnings.map((w: string) => `  - ${w}`).join("\n")}`);
      if (validation.ok && validation.warnings.length === 0) parts.push("TASK ALMOST COMPLETE: All checks passed. You MUST do one self-review pass (read_code, optional str_replace), then write final summary with estimated loop duration in seconds. DO NOT STOP.");
      if (validation.ok && validation.warnings.length > 0) parts.push("TASK INCOMPLETE: ok=true but warnings exist. You MUST NOT STOP. Call read_code() then fix with str_replace.");
      if (!validation.ok) parts.push("TASK INCOMPLETE: There are errors. You MUST NOT STOP. Call read_code() then fix with str_replace.");
      const resultText = parts.join("\n");

      sendSSE(res, { type: "tool_result_debug", toolName: "commit_code", result: resultText });
      return {
        content: [{ type: "text" as const, text: resultText }],
        details: { ...params, code: currentCode, validation },
      };
    },
  };

  const strReplaceTool: ToolDefinition<any> = {
    name: "str_replace",
    label: "Edit Code",
    description: "Replace an exact substring in the current code, then automatically validate. Returns edit status + validation results.",
    parameters: Type.Object({
      old_str: Type.String({ description: "Exact string to find and replace (must be unique in the code)" }),
      new_str: Type.String({ description: "Replacement string" }),
      description: Type.String({ description: "Brief description of what this change does" }),
    }),
    execute: async (_toolCallId, params) => {
      if (!currentCode) throw new Error("No committed code exists yet. Use commit_code first.");
      const count = currentCode.split(params.old_str).length - 1;
      if (count === 0) throw new Error(`old_str not found in current code. Make sure it matches exactly.`);
      if (count > 1) throw new Error(`old_str matches ${count} times. Provide a more unique string.`);
      currentCode = currentCode.replace(params.old_str, params.new_str);
      sendSSE(res, { type: "code_update", code: currentCode, library: currentLibrary, mode: "patch" });

      // Auto-validate
      const validation = await validateCode(currentCode, currentLibrary);
      const parts: string[] = [`Applied edit: ${params.description}.`];
      parts.push(`\nValidation — ok: ${validation.ok}`);
      if (validation.errors.length) parts.push(`errors:\n${validation.errors.map((e: string) => `  - ${e}`).join("\n")}`);
      if (validation.warnings.length) parts.push(`warnings:\n${validation.warnings.map((w: string) => `  - ${w}`).join("\n")}`);
      if (validation.ok && validation.warnings.length === 0) parts.push("TASK ALMOST COMPLETE: All checks passed. You MUST do one self-review pass (read_code, optional str_replace), then write final summary with estimated loop duration in seconds. DO NOT STOP.");
      if (validation.ok && validation.warnings.length > 0) parts.push("TASK INCOMPLETE: ok=true but warnings exist. You MUST NOT STOP. Call read_code() then fix with str_replace.");
      if (!validation.ok) parts.push("TASK INCOMPLETE: There are errors. You MUST NOT STOP. Call read_code() then fix with str_replace.");
      const strReplaceResult = parts.join("\n");

      sendSSE(res, { type: "tool_result_debug", toolName: "str_replace", result: strReplaceResult });
      return {
        content: [{ type: "text" as const, text: strReplaceResult }],
        details: { ...params, resultCode: currentCode, validation },
      };
    },
  };

  const validateCodeTool: ToolDefinition<any> = {
    name: "validate_code",
    label: "Validate Code",
    description: "Runs static checks and browser runtime checks on the current animation code. Returns ok=true when there are no errors. Warnings may still exist even when ok=true — fix all warnings before summarizing.",
    parameters: Type.Object({}),
    execute: async () => {
      if (!currentCode) {
        return {
          content: [{ type: "text" as const, text: "No code to validate. Call commit_code first." }],
          details: { ok: false, errors: ["No code written yet"], warnings: [] },
        };
      }
      const result = await validateCode(currentCode, currentLibrary);
      const lines: string[] = [];
      lines.push(`ok: ${result.ok}`);
      if (result.errors.length) lines.push(`errors:\n${result.errors.map((e: string) => `  - ${e}`).join("\n")}`);
      if (result.warnings.length) lines.push(`warnings:\n${result.warnings.map((w: string) => `  - ${w}`).join("\n")}`);
      if (result.ok && result.warnings.length === 0) lines.push("TASK ALMOST COMPLETE: All checks passed. You MUST do one self-review pass (read_code, optional str_replace), then write final summary with estimated loop duration in seconds. Ending without final summary is forbidden.");
      if (result.ok && result.warnings.length > 0) lines.push("ok=true but warnings exist. Call read_code() first, then fix every warning with str_replace, then call validate_code again.");
      const validateResultText = lines.join("\n");
      sendSSE(res, { type: "tool_result_debug", toolName: "validate_code", result: validateResultText });
      return {
        content: [{ type: "text" as const, text: validateResultText }],
        details: result,
      };
    },
  };

  const model = buildModel(config);
  const { createAgentSession, SessionManager, AuthStorage, DefaultResourceLoader } = await loadCodingAgent();
  const authStorage = AuthStorage.create();
  authStorage.set(config.provider, { type: "api_key", key: config.apiKey });

  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    systemPromptOverride: () => SYSTEM_PROMPT,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    model,
    tools: [],
    customTools: [readCodeTool, commitCodeTool, strReplaceTool, validateCodeTool],
    sessionManager: options?.sessionManager ?? SessionManager.inMemory(),
    authStorage,
    resourceLoader,
  });

  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_start") {
      
      try {
        const state = (session.agent as any).state || (session.agent as any)._state;
        const sysPrompt = state?.systemPrompt || SYSTEM_PROMPT;
        const msgList = state?.messages || [];
        const formattedMsgs = msgList.map((m: any) => {
          let content = "";
          if (m.role === "toolResult") {
            content = `[toolResult: ${m.toolName}]\n${(m.content ?? []).map((c: any) => c?.text ?? "").join("")}`;
          } else if (Array.isArray(m.content)) {
            content = m.content.map((c: any) => {
              if (c.type === "text") return c.text;
              if (c.type === "thinking") return `[thinking]\n${c.thinking}`;
              if (c.type === "toolCall") return `[toolCall: ${c.name}]`;
              if (c.type === "image") return "[image]";
              return JSON.stringify(c);
            }).join("\n");
          } else if (typeof m.content === "string") {
            content = m.content;
          }
          return { role: m.role, content };
        });
        sendSSE(res, { type: "context_debug", messages: [{ role: "system", content: sysPrompt }, ...formattedMsgs] });
      } catch (e) {
        console.error("Error formatting context_debug", e);
      }

    }

    if (event.type === "turn_end") {
    }

    if (event.type === "agent_end") {
      const evMsgs = (event as any).messages ?? [];
      const lastMsg = evMsgs[evMsgs.length - 1] as any;
      if (lastMsg?.stopReason === "error") {
        console.error("[agent_end error] lastMsg:", JSON.stringify(lastMsg, null, 2));
        const errText = lastMsg.errorMessage
          || lastMsg.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
          || "请求失败";
        sendSSE(res, { type: "error", message: errText });
      }
    }
    sendSSE(res, event);
    if (event.type === "agent_end" && !res.writableEnded) {
      res.end();
    }
  });

  return { session, setRes: (r: Response) => { res = r; } };
}

export function sendSSE(res: Response, data: unknown): void {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
