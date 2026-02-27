/**
 * Agno agent proxy — connects the TS Express backend to the Python Agno service.
 *
 * When USE_AGNO=true, the TS backend calls the Python /run endpoint instead of
 * the local Pi coding agent. The Agno service is stateless; we pass the full
 * context (history, current code, config) on every request.
 */

import { Response } from "express";
import { sendSSE, type LLMConfig } from "./agent";
import type { ChatMessage as StoredMessage } from "./store";

const AGNO_URL = process.env.AGNO_URL ?? "http://agno-agent:8100";

export interface AgnoSession {
  prompt: (message: string, opts: { images?: any[] }) => Promise<void>;
  abort: () => void;
  setRes: (r: Response) => void;
}

export function createAgnoSession(
  config: LLMConfig,
  initialRes: Response,
  getContextSnapshot: () => {
    messages: StoredMessage[];
    currentCode: string;
    currentLibrary: string;
  }
): AgnoSession {
  let res = initialRes;
  let abortController = new AbortController();

  const prompt = async (message: string, opts: { images?: any[] } = {}) => {
    abortController = new AbortController();

    const { messages, currentCode, currentLibrary } = getContextSnapshot();

    // Build history in the format Agno expects (last 20 messages max)
    const history = messages.slice(-20).map((m) => ({
      role: m.role === "tool" ? "assistant" : m.role,
      content: m.role === "tool" ? `[Tool: ${m.toolName ?? m.content}]` : m.content,
    }));

    const body = JSON.stringify({
      config: {
        provider: config.provider,
        model_id: config.modelId,
        api_key: config.apiKey,
        base_url: config.baseUrl ?? null,
        strip_thinking: config.stripThinking ?? false,
      },
      message,
      current_code: currentCode,
      current_library: currentLibrary,
      history,
      images: opts.images ?? [],
    });

    let httpRes: globalThis.Response;
    try {
      httpRes = await fetch(`${AGNO_URL}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: abortController.signal,
      });
    } catch (err: any) {
      if (err.name === "AbortError") return;
      sendSSE(res, { type: "error", message: `Agno service unreachable: ${err.message}` });
      if (!res.writableEnded) res.end();
      return;
    }

    if (!httpRes.body) {
      sendSSE(res, { type: "error", message: "Agno service returned no body" });
      if (!res.writableEnded) res.end();
      return;
    }

    // Pipe the SSE stream from Python → TS client
    const reader = httpRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            sendSSE(res, evt);

            if (evt.type === "agent_end" && !res.writableEnded) {
              res.end();
              return;
            }
          } catch {
            // malformed JSON line — skip
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        sendSSE(res, { type: "error", message: err.message });
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  };

  return {
    prompt,
    abort: () => abortController.abort(),
    setRes: (r: Response) => {
      res = r;
    },
  };
}
