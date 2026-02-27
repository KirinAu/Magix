"""
FastAPI server — chains 分析者 → 代码者 → 总结者 and streams SSE.
Compatible with the TS backend's event interceptor format.
"""
from __future__ import annotations
import asyncio
import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from agno.agent import RunEvent

from src.config import RunRequest
from src.agents import make_agents

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("agno-agent")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Agno agent service starting")
    yield
    logger.info("Agno agent service shutting down")


app = FastAPI(title="MagicEffect Agno Agent", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def translate_run_event(event, agent_name: str) -> dict | None:
    ev = getattr(event, "event", None)

    if ev == RunEvent.run_content.value:
        content = getattr(event, "content", None)
        if content:
            return {
                "type": "message_update",
                "agentName": agent_name,
                "assistantMessageEvent": {"type": "text_delta", "delta": content},
            }
        return None

    if ev == RunEvent.tool_call_started.value:
        tool = getattr(event, "tool", None)
        tool_name = getattr(tool, "tool_name", "") if tool else ""
        return {
            "type": "message_update",
            "agentName": agent_name,
            "assistantMessageEvent": {"type": "toolcall_start", "toolName": tool_name},
        }

    if ev == RunEvent.tool_call_completed.value:
        tool = getattr(event, "tool", None)
        tool_name = getattr(tool, "tool_name", "") if tool else ""
        return {
            "type": "message_update",
            "agentName": agent_name,
            "assistantMessageEvent": {"type": "toolcall_end", "toolName": tool_name},
        }

    return None


async def run_agent_streaming(agent, input_str: str, agent_name: str, queue: asyncio.Queue) -> str:
    full_text = ""
    try:
        async for event in await agent.arun(input_str, stream=True, stream_events=True):
            translated = translate_run_event(event, agent_name)
            if translated:
                await queue.put(translated)
            if getattr(event, "event", None) == RunEvent.run_content.value:
                full_text += getattr(event, "content", "") or ""
    except Exception as e:
        logger.exception(f"Error in agent {agent_name}")
        await queue.put({"type": "error", "message": f"[{agent_name}] {e}"})
    return full_text


# ── Workflow ──────────────────────────────────────────────────────────────────

async def run_workflow(req: RunRequest, queue: asyncio.Queue, code_state: dict):
    try:
        analyzer, coder, summarizer = make_agents(req.config, queue, code_state)

        # Build context strings
        history_ctx = ""
        if req.history:
            lines = []
            for msg in req.history[-10:]:
                if msg.role in ("user", "assistant"):
                    lines.append(f"[{msg.role}]: {msg.content[:500]}")
            if lines:
                history_ctx = "## Conversation history\n" + "\n".join(lines) + "\n\n"

        code_ctx = ""
        if code_state.get("code"):
            code_ctx = (
                f"\n\n## Current animation code ({code_state['library']})\n"
                f"```js\n{code_state['code']}\n```"
            )

        user_message = req.message

        # ── Step 1: 分析者 ────────────────────────────────────────────────────
        await queue.put({"type": "agent_start", "agent": "分析者"})
        analyzer_input = f"{history_ctx}## User request\n{user_message}{code_ctx}"
        analysis = await run_agent_streaming(analyzer, analyzer_input, "分析者", queue)
        await queue.put({
            "type": "message_update",
            "agentName": "分析者",
            "assistantMessageEvent": {"type": "text_done"},
        })

        # ── Step 2: 代码者 ────────────────────────────────────────────────────
        await queue.put({"type": "agent_switch", "from": "分析者", "to": "代码者"})
        await queue.put({"type": "agent_start", "agent": "代码者"})
        coder_input = (
            f"## Analyzer's Brief\n{analysis}\n\n"
            f"## User Request\n{user_message}"
            f"{code_ctx}"
        )
        await run_agent_streaming(coder, coder_input, "代码者", queue)
        await queue.put({
            "type": "message_update",
            "agentName": "代码者",
            "assistantMessageEvent": {"type": "text_done"},
        })

        # ── Step 3: 总结者 ────────────────────────────────────────────────────
        await queue.put({"type": "agent_switch", "from": "代码者", "to": "总结者"})
        await queue.put({"type": "agent_start", "agent": "总结者"})
        summarizer_input = (
            f"## User request\n{user_message}\n\n"
            f"## Analyzer brief\n{analysis}\n\n"
            f"## Final library used\n{code_state.get('library', 'gsap')}\n\n"
            "The Coder has finished. Write the summary reply."
        )
        await run_agent_streaming(summarizer, summarizer_input, "总结者", queue)
        await queue.put({
            "type": "message_update",
            "agentName": "总结者",
            "assistantMessageEvent": {"type": "text_done"},
        })

        await queue.put({"type": "turn_end"})
        await queue.put({"type": "agent_end"})

    except Exception as e:
        logger.exception("Workflow error")
        await queue.put({"type": "error", "message": str(e)})
        await queue.put({"type": "agent_end"})
    finally:
        await queue.put(None)  # sentinel


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.post("/run")
async def run_endpoint(req: RunRequest):
    """Runs 分析者→代码者→总结者 and streams SSE events."""
    queue: asyncio.Queue = asyncio.Queue()
    code_state = {"code": req.current_code, "library": req.current_library}

    asyncio.create_task(run_workflow(req, queue, code_state))

    async def event_stream():
        while True:
            event = await queue.get()
            if event is None:
                break
            yield sse(event)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.get("/health")
async def health():
    return {"ok": True, "service": "agno-agent"}
