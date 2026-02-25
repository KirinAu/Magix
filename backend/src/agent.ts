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

Rules:
- Always use the write_code tool to output your animation code
- The code runs inside a <script> tag in an HTML page that already has GSAP or Anime.js loaded
- Do NOT include <script> tags, HTML, or import statements
- The page has a black background (${`width`} x ${`height`} px), use the full canvas
- For GSAP: create elements dynamically or use existing DOM, then animate with gsap.to/from/timeline
- For Anime.js: create elements and use anime() — instances are auto-collected for seeking
- Make animations that loop or have a clear duration
- Be creative with colors, shapes, and motion

When the user asks for changes, update the full code and call write_code again.`;

function buildModel(config: LLMConfig): Model<any> {
  // Determine API type based on provider
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
  res: Response  // SSE response object
): Agent {
  // Tool: write_code — streams code back to frontend via SSE
  const writeCodeTool: AgentTool<any> = {
    name: "write_code",
    label: "Write Animation Code",
    description: "Output the complete animation code. Call this whenever you produce or update animation code.",
    parameters: Type.Object({
      code: Type.String({ description: "Complete animation JavaScript code" }),
      library: Type.Union(
        [Type.Literal("gsap"), Type.Literal("anime")],
        { description: "Which animation library this code uses" }
      ),
      description: Type.String({ description: "Brief description of what this animation does" }),
    }),
    execute: async (_toolCallId, params) => {
      // Tool execution is a no-op — the actual streaming happens via message_update events
      return {
        content: [{ type: "text" as const, text: `Code written: ${params.description}` }],
        details: params,
      };
    },
  };

  const model = buildModel(config);

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: [writeCodeTool],
    },
    getApiKey: () => config.apiKey,
  });

  // Subscribe and forward all events to SSE
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
