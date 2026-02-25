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
Your job is to write high-quality, creative animation code that runs in a browser sandbox (1280x720px, black background).

## Environment
- The code runs inside a <script> tag. GSAP or Anime.js is already loaded globally.
- Do NOT include <script> tags, HTML, or import statements.
- For GSAP: create DOM elements dynamically, animate with gsap.to/from/timeline/fromTo.
- For Anime.js: create elements and use anime() — instances are auto-collected for time-seeking.
- Animations must loop (repeat: -1) or have a clear total duration.

## Tools
You have two code tools:

### write_code(code, library, description)
Use for: initial generation, or when changes are large enough that a full rewrite is cleaner.

### str_replace(old_str, new_str, description)
Use for: targeted edits — changing a color, tweaking a value, fixing a bug.
- old_str must match EXACTLY (including whitespace) a unique substring of the current code.
- new_str is the replacement.
- Prefer this over write_code when the change is small.

## Workflow
1. Think about what the user wants.
2. Write or edit the code using the appropriate tool.
3. Explain briefly what you did and why.

Always produce complete, runnable code. Be creative with colors, shapes, and motion.`;

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
    maxTokens: 8192,
  };
}

export function createAnimationAgent(
  config: LLMConfig,
  res: Response
): Agent {
  // 维护当前代码状态（session 级别）
  let currentCode = "";

  const writeCodeTool: AgentTool<any> = {
    name: "write_code",
    label: "Write Animation Code",
    description: "Output the complete animation code. Use for initial generation or full rewrites.",
    parameters: Type.Object({
      code: Type.String({ description: "Complete animation JavaScript code" }),
      library: Type.Union(
        [Type.Literal("gsap"), Type.Literal("anime")],
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
        content: [{ type: "text" as const, text: `Code written (${params.code.split("\n").length} lines): ${params.description}` }],
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
      tools: [writeCodeTool, strReplaceTool],
    },
    getApiKey: () => config.apiKey,
  });

  agent.subscribe((event: AgentEvent) => {
    sendSSE(res, event);
  });

  return agent;
}

export function sendSSE(res: Response, data: unknown): void {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
