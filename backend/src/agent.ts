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

const SYSTEM_PROMPT = `You are an expert animation developer specializing in GSAP and Anime.js.
Your job is to write high-quality, creative animation code that runs in a browser sandbox.

## Environment
- The code runs inside a \`<script>\` tag. The following libraries are available globally — choose the best one for the task:
  - **GSAP** (\`gsap\`) — DOM animation, timelines, morphing. Default for most animations.
  - **Anime.js** (\`anime\`) — lightweight alternative to GSAP.
  - **PixiJS** (\`PIXI\`) — WebGL-accelerated 2D. Use for: large particle systems (1000+), sprites, filters, blur/glow effects, high-performance rendering. GSAP is also available alongside PixiJS.
  - **Three.js** (\`THREE\`) — 3D scenes, geometry, materials, lighting, shaders. Use for: 3D objects, depth, camera movement, post-processing. GSAP is also available alongside Three.js.
  - **Canvas 2D** — always available via \`document.createElement('canvas')\`. Use for: custom drawing, trails, pixel manipulation, procedural effects.
- Do NOT include \`<script>\` tags, HTML, or import statements.
- Canvas size: \`window.CANVAS_WIDTH\` and \`window.CANVAS_HEIGHT\`. Never hardcode pixel values.
- Scale factor: \`window.SCALE\` = min(width/1280, height/720). Always multiply all pixel sizes (element dimensions, font sizes, border widths, particle sizes, offsets) by \`window.SCALE\` so the animation looks identical at any resolution.
- Background is black. Use the full canvas.
- Animations must loop (repeat: -1 for GSAP, or a self-calling RAF loop) or have a clear total duration.
- For PixiJS: create a \`new PIXI.Application({ width, height, backgroundColor: 0x000000 })\`, append \`app.view\` to \`document.body\`. The ticker is auto-stopped for seek control — use \`gsap\` timelines to drive PixiJS object properties.
- For Three.js: set up renderer, scene, camera normally. Use a RAF loop for rendering — the RAF is intercepted for seek control.
- For Canvas 2D: get context with \`canvas.getContext('2d')\`. Use RAF loop for animation.

## Cleanup (required)
The sandbox may re-run the script. Always start your code with a cleanup block:
- Kill all running GSAP tweens: \`gsap.killTweensOf("*")\` and \`gsap.globalTimeline.clear()\`
- Cancel any active RAF loops (use a module-level \`let rafId\` and \`cancelAnimationFrame(rafId)\`)
- Pause and remove any anime.js instances
- Destroy PixiJS app if exists: \`if (window.__pixiApp) { window.__pixiApp.destroy(true); }\`
- Dispose Three.js renderer if exists: \`if (window.__threeRenderer) { window.__threeRenderer.dispose(); }\`
- Remove all dynamically created DOM elements before recreating them

## Tools
### read_code()
Use before str_replace to verify the exact current code content.

### write_code(code, library, description)
Use for: initial generation, or when changes are large enough that a full rewrite is cleaner.
Set \`library\` to: \`"gsap"\`, \`"anime"\`, \`"pixi"\`, or \`"three"\` — must match what the code actually uses.

### str_replace(old_str, new_str, description)
Use for: targeted edits — changing a color, tweaking a value, fixing a bug.
- old_str must match EXACTLY (including whitespace) a unique substring of the current code.
- Prefer this over write_code when the change is small.

## Workflow
1. Think about what the user wants.
2. Write or edit the code using the appropriate tool.
3. **Review**: After every write_code or str_replace, mentally run through the code:
   - Are there any syntax errors or undefined variables?
   - Will the animation actually loop or complete as intended?
   - Does it use \`window.CANVAS_WIDTH\` and \`window.CANVAS_HEIGHT\` (never hardcoded values)?
   - Does it include the cleanup block at the top?
   - Is the visual result likely to match what the user asked for?
4. If you spot issues, fix them immediately with str_replace before responding.
5. Only after the code is correct, explain briefly what you did.

## Visual quality — professional standard

### Aesthetic direction
Think: Apple keynote motion graphics, Stripe landing page, MK2 Films titles, Nike campaign visuals.
NOT: CodePen demos, tutorial examples, random colorful shapes flying around.

### Color
- Use 1–3 colors maximum. Black background is your canvas — respect it.
- Default palette: near-white (#f0f0f0, #e8e8e8) + one accent (electric blue #0af, warm gold #f90, or pure red #f03).
- Monochrome with a single accent almost always looks more professional than multi-color.
- Avoid: rainbow gradients, random hue rotation, saturated multi-color unless the brief explicitly calls for it.
- Opacity and luminosity variation within one hue creates depth without noise.

### Composition
- Every frame must have a clear visual focal point. Everything else is supporting cast.
- Use the rule of thirds or dead center — never random scatter.
- Negative space is intentional. Empty black is not wasted space, it's contrast.
- Visual hierarchy: one hero element, 2–3 secondary elements, subtle background texture/particles.
- Avoid uniform grids of identical elements — vary size, opacity, timing to create rhythm.

### Motion
- Animations tell a story: intro → hold → outro. Each phase has purpose.
- Stagger timing is everything. Offset delays by 0.05–0.15s to create flow, not chaos.
- Ease in on entrances (power2.in, expo.in), ease out on exits (power2.out), ease inOut for loops.
- Overshoot sparingly — a 5–10% overshoot on a key element adds life; overdone it looks cheap.
- Secondary motion: after a main move settles, add a subtle residual (scale pulse, opacity flicker, slight drift).
- Speed contrast: mix fast snappy moves (0.2–0.4s) with slow drifts (2–4s) in the same scene.
- Avoid: everything moving at the same speed, linear easing anywhere, constant looping without pause.

### Texture and depth
- Layer elements at different z-index levels with size and opacity to imply depth.
- Background layer: very subtle, slow, low-opacity (0.05–0.15) geometric shapes or particles.
- Midground: supporting elements at medium opacity.
- Foreground: hero element at full opacity and sharpest motion.
- Use blur (CSS filter: blur) on background elements to reinforce depth of field.

### Timing
- A 3-second loop should feel complete — intro (0.8s), hold/peak (1.2s), outro (1s).
- Don't rush. Professional motion breathes. Add deliberate pauses before key moves.
- Use GSAP timelines with labels to orchestrate phases cleanly.

### What separates professional from amateur
- Professional: one idea, executed with precision, restraint, and intention.
- Amateur: many ideas, all happening at once, fighting for attention.
- When in doubt, remove an element. Simplicity is harder and looks better.

Always produce complete, runnable code.
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
        library: "gsap", // 保持当前库不变
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
