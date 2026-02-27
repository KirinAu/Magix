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
**IMPORTANT: Call only ONE tool at a time. Wait for the result before calling the next tool.**
- **read_code()** — read current committed code before str_replace.
- **commit_code(code, library, description)** — commit JavaScript code directly via the \`code\` parameter. Do NOT output a markdown code block separately; pass the full code as the \`code\` argument. \`library\` must be one of: \`gsap\`, \`anime\`, \`pixi\`, \`three\`, \`canvas\`. **You MUST call validate_code immediately after every commit_code. No exceptions.**
- **str_replace(old_str, new_str, description)** — targeted edit on committed code. \`old_str\` must be unique and exact. **You MUST call validate_code immediately after every str_replace. No exceptions.**
- **validate_code()** — runs static + browser runtime checks on committed code. Returns \`ok\`, \`errors\`, \`warnings\`. **You MUST call this after every commit_code or str_replace. You MUST NOT finish until validate_code returns ok=true.**

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
Call \`commit_code(code, library, description)\` with the complete JavaScript code in the \`code\` parameter.

### Step 3 — Validate
Call \`validate_code()\`. If it returns errors, go to Step 4. If warnings only, call \`read_code()\` first, then fix with \`str_replace\`, then validate again.

### Step 4 — Fix
Call \`read_code()\` to get the exact current code, then fix every issue with \`str_replace\`, then call \`validate_code()\` again. Repeat until \`ok=true\` and no warnings. Max 5 fix rounds.

### Step 5 — Summarize
Only after \`validate_code\` returns \`ok=true\`: short reply with what was built + recommended loop duration.

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
  initialRes: Response
): Promise<{ session: any; setRes: (r: Response) => void }> {
  let currentCode = "";
  let currentLibrary = "gsap";
  let res = initialRes;

  const readCodeTool: ToolDefinition<any> = {
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

  const commitCodeTool: ToolDefinition<any> = {
    name: "commit_code",
    label: "Commit Draft Code",
    description: "Commit JavaScript animation code. Pass the complete code directly in the `code` parameter.",
    parameters: Type.Object({
      code: Type.String({ description: "The complete JavaScript animation code to commit" }),
      library: Type.Union(
        [Type.Literal("gsap"), Type.Literal("anime"), Type.Literal("pixi"), Type.Literal("three"), Type.Literal("canvas")],
        { description: "Which animation library this code uses" }
      ),
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
      return {
        content: [{ type: "text" as const, text: `Code committed (${currentCode.split("\n").length} lines): ${params.description}. YOU MUST NOW call validate_code() immediately. Do not output any text before calling validate_code.` }],
        details: { ...params, code: currentCode },
      };
    },
  };

  const strReplaceTool: ToolDefinition<any> = {
    name: "str_replace",
    label: "Edit Code",
    description: "Replace an exact substring in the current code. Use for targeted edits.",
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
      return {
        content: [{ type: "text" as const, text: `Applied edit: ${params.description}. YOU MUST NOW call validate_code() immediately.` }],
        details: { ...params, resultCode: currentCode },
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
      if (result.ok && result.warnings.length === 0) lines.push("All checks passed. You may now summarize.");
      if (result.ok && result.warnings.length > 0) lines.push("ok=true but warnings exist. Fix the warnings with str_replace, then call validate_code again.");
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
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
    sessionManager: SessionManager.inMemory(),
    authStorage,
    resourceLoader,
  });

  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "agent_end") {
      const lastMsg = (event as any).messages?.[(event as any).messages.length - 1] as any;
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

  return { session, setRes: (r: Response) => { res = r; } };
}

export function sendSSE(res: Response, data: unknown): void {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
