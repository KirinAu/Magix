import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool, AgentEvent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Response } from "express";
import { validateCode } from "./validator";

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
- **read_code()** — read current committed code before str_replace.
- **begin_coding()** — call this after analysis to signal you are ready to write code. No parameters.
- **commit_code(library, description)** — commit the latest JavaScript code block you just wrote in assistant text.
- **str_replace(old_str, new_str, description)** — targeted edit on committed code. \`old_str\` must be unique and exact.
- **validate_code()** — runs static + browser runtime checks on committed code. Returns \`ok\`, \`errors\`, \`warnings\`. **You MUST call this after every commit_code or str_replace. You MUST NOT finish until validate_code returns ok=true.**

## Workflow
**IMPORTANT: Follow these steps in strict order. Each step is a separate message.**

### Step 1 — Analyze (text only, no tool calls)
Output a short analysis in plain text:
- **Intent**: What is the user really asking for? What mood, style, feeling?
- **Library**: Which library and why?
- **Concept**: Core visual idea in one sentence.
- **Color**: Palette (max 3 colors).
- **Motion**: Key motion beats — what moves, when, how fast?

### Step 2 — Begin Coding
Call \`begin_coding()\`. Nothing else in this message.

### Step 3 — Draft Code (code only)
Output ONLY a single JavaScript markdown code block. The entire message must be exactly:
\`\`\`js
// your code here
\`\`\`
Nothing before or after the code block is allowed.

### Step 4 — Commit
Call \`commit_code(library, description)\` to save that code block as current code.

### Step 5 — Validate
Call \`validate_code()\`. If it returns errors, go to Step 6. If warnings only, fix then validate again.

### Step 6 — Fix
Fix every issue with \`str_replace\`, then call \`validate_code()\` again. Repeat until \`ok=true\`. Max 5 fix rounds.

### Step 7 — Summarize
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
  let assistantDraftText = "";
  let res = initialRes;

  function extractLatestJsCodeBlock(text: string): string | null {
    const re = /```(?:javascript|js)?\n([\s\S]*?)```/gi;
    let match: RegExpExecArray | null = null;
    let last: string | null = null;
    while ((match = re.exec(text)) !== null) {
      last = match[1];
    }
    return last ? last.trim() : null;
  }

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

  const beginCodingTool: AgentTool<any> = {
    name: "begin_coding",
    label: "Begin Coding",
    description: "Call this after your analysis to signal you are ready to write code. No parameters.",
    parameters: Type.Object({}),
    execute: async () => {
      return {
        content: [{ type: "text" as const, text: "Analysis locked in. Now output ONLY a single ```js code block. No other text." }],
        details: {},
      };
    },
  };

  const commitCodeTool: AgentTool<any> = {
    name: "commit_code",
    label: "Commit Draft Code",
    description: "Commit the latest JavaScript markdown code block from assistant text into current editable code.",
    parameters: Type.Object({
      library: Type.Union(
        [Type.Literal("gsap"), Type.Literal("anime"), Type.Literal("pixi"), Type.Literal("three")],
        { description: "Which animation library this code uses" }
      ),
      description: Type.String({ description: "Brief description of this committed code" }),
    }),
    execute: async (_toolCallId, params) => {
      const draftCode = extractLatestJsCodeBlock(assistantDraftText);
      if (!draftCode) {
        throw new Error("No JavaScript markdown code block found in latest assistant output. Output a ```js code block first, then call commit_code.");
      }
      currentCode = draftCode;
      currentLibrary = params.library;
      sendSSE(res, {
        type: "code_update",
        code: currentCode,
        library: params.library,
        mode: "full",
      });
      return {
        content: [{ type: "text" as const, text: `Code committed (${currentCode.split("\n").length} lines): ${params.description}. Now call validate_code. If there are issues, fix with str_replace and validate again.` }],
        details: { ...params, code: currentCode },
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
        throw new Error("No committed code exists yet. Use commit_code first.");
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

  const validateCodeTool: AgentTool<any> = {
    name: "validate_code",
    label: "Validate Code",
    description: "Runs static checks and browser runtime checks on the current animation code. Returns ok=true only when there are no errors. You MUST call this after every commit_code or str_replace, and MUST NOT finish until ok=true.",
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
      if (result.errors.length) lines.push(`errors:\n${result.errors.map(e => `  - ${e}`).join("\n")}`);
      if (result.warnings.length) lines.push(`warnings:\n${result.warnings.map(w => `  - ${w}`).join("\n")}`);
      if (result.ok) lines.push("All checks passed. You may now summarize.");
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: result,
      };
    },
  };

  const model = buildModel(config);

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: [readCodeTool, beginCodingTool, commitCodeTool, strReplaceTool, validateCodeTool],
    },
    getApiKey: () => config.apiKey,
  });

  agent.subscribe((event: AgentEvent) => {
    if (event.type === "agent_start") {
      assistantDraftText = "";
    }
    if (event.type === "message_update") {
      const ae = (event as any).assistantMessageEvent;
      if (ae?.type === "text_delta") {
        assistantDraftText += ae.delta ?? "";
      }
    }
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
