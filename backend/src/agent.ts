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

const SYSTEM_PROMPT = `<persona>
You are an expert animation developer. Write high-quality, creative animation code for a browser sandbox.
</persona>

<environment_rules>
- Code runs inside a \`<script>\` tag. Available libraries:
  - **GSAP** (\`gsap\`) — DOM animation, timelines. Default choice.
  - **Anime.js** (\`anime\`) — lightweight GSAP alternative.
  - **PixiJS** (\`PIXI\`) — WebGL 2D. Use for large particle systems (1000+), sprites.
  - **Three.js** (\`THREE\`) — 3D scenes, PBR materials, shaders.
  - **ECharts** (\`echarts\`) — data visualisation, animated charts.
  - **Canvas 2D** — always available via \`document.createElement('canvas')\`.
- NO \`<script>\` tags, HTML, or import statements in your output.
- Canvas size: \`window.CANVAS_WIDTH\` / \`window.CANVAS_HEIGHT\`. Use percentages/fractions for positions.
- **CRITICAL SCALE RULE**: \`window.SCALE\` = min(width/1280, height/720). **You MUST multiply all absolute sizes, fonts, strokes, and line widths by \`window.SCALE\` so the animation scales to 4K screens.**
  - Example: \`const radius = 50 * window.SCALE;\`
- Features: Black background. Animations MUST loop or have a specific duration.
- **PixiJS**: \`new PIXI.Application({width, height, backgroundColor:0})\`, append \`app.view\`.
- **Three.js & Canvas**: Use RAF loop for rendering (intercepted for seek). **NEVER use \`gsap.ticker.add()\` for render loops** (causes black frames on export).
- **ECharts**: Create a \`<div>\` matching CANVAS dimensions, call \`echarts.init(div)\`. Store instance on \`window.__echartsInstance\`.
</environment_rules>

<cleanup_block_mandatory>
Always start your code with this exact block:
\`\`\`js
gsap.killTweensOf("*"); gsap.globalTimeline.clear();
if (window.__rafId) cancelAnimationFrame(window.__rafId);
if (window.__pixiApp) { window.__pixiApp.destroy(true); window.__pixiApp = null; }
if (window.__threeRenderer) { window.__threeRenderer.dispose(); window.__threeRenderer = null; }
if (window.__echartsInstance) { window.__echartsInstance.dispose(); window.__echartsInstance = null; }
document.querySelectorAll('canvas, .anim-el').forEach(el => el.remove());
\`\`\`
</cleanup_block_mandatory>

<system_constraints>
1. **NEVER call multiple tools in parallel.** You MUST wait for the result of step N before calling step N+1.
2. DO NOT output conversational filler like "Sure, I can help with that."
3. DO NOT apologize or explain CSS/JS choices unless specifically asked.
4. Tool call style: Before \`commit_code\` or \`str_replace\`, output EXACTLY one short sentence (<= 20 words) explaining the change.
</system_constraints>

<tool_response_handling_rules>
IF user reports a runtime error, visual problem, or asks to modify code:
  1. ALWAYS call \`read_code()\` FIRST to get current state.
  2. Fix using \`str_replace\` or \`commit_code\`.

IF tool result has \`errors\` or \`warnings\`:
  1. Generate text acknowledging the error.
  2. Call \`read_code()\` if context is missing.
  3. Call \`str_replace()\` to fix. Repeat up to 5 times until \`ok=true\`.

IF tool result is \`ok=true\` with 0 warnings:
  1. DO NOT STOP. You are NOT DONE.
  2. Proceed to SELF-REVIEW (Step 3.5).
</tool_response_handling_rules>

<workflow>
IMPORTANT: Execute these sequence in strict order!

**Step 1. Analyze (Text only)**
Output short analysis: Intent, Library choice, Concept, Color palette, Motion beats.

**Step 2. Commit Code**
Call \`commit_code(code, library, description)\`. Validation runs automatically, returns result.

**Step 3. Fix Errors**
(See tool_response_handling_rules).

**Step 3.5. Self-Review (MANDATORY)**
Once validation is clean:
1. Call \`read_code()\`. Review for: readability, performance, SCALE rules, cleanup, timing.
2. If improvement needed, apply via \`str_replace()\` (auto-validates). Max 2 review loops.

**Step 4. Final Summary (MANDATORY)**
Only after code is fully validated and reviewed, output the final message:
- What was built & Library used.
- **Estimated loop duration** (e.g., \`Loop: ~3.2s\`).
</workflow>

<visual_quality>
- Aesthetic: Apple keynote / Stripe (Premium, polished). NOT CodePen tech-demos.
- Color: 1-3 colors max. Black bg + accent > rainbow.
- Motion: Intro → Hold → Outro. Stagger 0.05-0.15s. Mix fast snaps (0.2s) with slow drifts (3s). NO linear easing.
- Restraint: One strong idea. Less is more.
</visual_quality>

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
      
      parts.push("\n---");
      if (validation.ok && validation.warnings.length === 0) {
        parts.push("✅ TASK ALMOST COMPLETE: All checks passed.");
        parts.push("NEXT ACTION REQUIREMENTS:");
        parts.push("1. Wait for user feedback. If the user explicitly asks for changes, you MUST read_code() first and fix.");
        parts.push("2. If this was an autonomous loop and user hasn't intervened: perform a quick self-review, then produce the final summary text with estimated loop duration. DO NOT halt silently without a summary.");
      } else {
        parts.push("❌ TASK INCOMPLETE: Code has errors or warnings.");
        parts.push("NEXT ACTION REQUIREMENTS:");
        parts.push("1. DO NOT STOP. You MUST fix this autonomously unless the user explicitly told you to wait.");
        parts.push("2. Call read_code() to grasp the context, then call str_replace() to fix it.");
      }
      
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
    label: "Edit Code (Human-in-the-Loop Safe)",
    description: "Replace an exact substring in the current code, then automatically validate. IF the match fails, DO NOT guess — call read_code to get the exact lines to replace. Always include around 3 lines of surrounding preserved code in old_str to ensure uniqueness.",
    parameters: Type.Object({
      old_str: Type.String({ description: "Exact string to find and replace (MUST be strictly identical to the code. Include 2-3 surrounding unchanged lines to guarantee uniqueness!)" }),
      new_str: Type.String({ description: "Replacement string, taking care to preserve the surrounding lines inherited from old_str" }),
      description: Type.String({ description: "Brief description of what this change does" }),
    }),
    execute: async (_toolCallId, params) => {
      if (!currentCode) throw new Error("No committed code exists yet. Use commit_code first.");
      const count = currentCode.split(params.old_str).length - 1;
      if (count === 0) throw new Error(`old_str not found in current code.\nYour string:\n${params.old_str}\n\nACTION REQUIRED: Call read_code() immediately to verify the exact whitespace and structure of the code you want to change.`);
      if (count > 1) throw new Error(`old_str matches ${count} times. You MUST provide more surrounding lines in old_str to make it unique.`);
      currentCode = currentCode.replace(params.old_str, params.new_str);
      sendSSE(res, { type: "code_update", code: currentCode, library: currentLibrary, mode: "patch" });

      // Auto-validate
      const validation = await validateCode(currentCode, currentLibrary);
      const parts: string[] = [`Applied edit: ${params.description}.`];
      parts.push(`\nValidation — ok: ${validation.ok}`);
      if (validation.errors.length) parts.push(`errors:\n${validation.errors.map((e: string) => `  - ${e}`).join("\n")}`);
      if (validation.warnings.length) parts.push(`warnings:\n${validation.warnings.map((w: string) => `  - ${w}`).join("\n")}`);
      
      parts.push("\n---");
      if (validation.ok && validation.warnings.length === 0) {
        parts.push("✅ HUMAN-IN-THE-LOOP CHECK: The edit is clean and valid. If you made this edit based on user feedback, stop and ask if they are satisfied. If this is an autonomous task, output your final summary.");
      } else {
        parts.push("❌ TASK INCOMPLETE: Edit caused new errors/warnings.");
        parts.push("NEXT ACTION REQUIREMENTS: Call read_code() to grasp the context, then call str_replace() to fix it.");
      }
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
