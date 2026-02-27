"""
Animation tools factory.
Returns a list of async tool functions that capture:
  - queue:      asyncio.Queue → pushes SSE events to the HTTP response stream
  - code_state: dict          → shared mutable { code, library }
"""
from __future__ import annotations
import asyncio
from src.validate import validate_code as _validate


def make_tools(queue: asyncio.Queue, code_state: dict) -> list:

    async def read_code() -> str:
        """
        Returns the current committed animation code.
        Call this before str_replace to verify the exact content.
        """
        code = code_state.get("code", "")
        if not code:
            return "No code written yet."
        return f"Current code:\n```js\n{code}\n```"

    async def commit_code(code: str, library: str, description: str) -> str:
        """
        Commit complete JavaScript animation code.
        Pass the complete code directly in the `code` parameter.
        `library` must be one of: gsap, anime, pixi, three, canvas.
        YOU MUST call validate_code() immediately after this. No exceptions.

        Args:
            code (str): The complete JavaScript animation code to commit.
            library (str): Which animation library this code uses. One of: gsap, anime, pixi, three, canvas.
            description (str): Brief description of this committed code.
        """
        code = code.strip()
        if not code:
            return "Error: code parameter is required and must not be empty."

        code_state["code"] = code
        code_state["library"] = library

        await queue.put({
            "type": "code_update",
            "code": code,
            "library": library,
            "mode": "full",
        })

        lines = len(code.splitlines())
        return (
            f"Code committed ({lines} lines): {description}. "
            "YOU MUST NOW call validate_code() immediately. Do not output any text before calling validate_code."
        )

    async def str_replace(old_str: str, new_str: str, description: str) -> str:
        """
        Replace an exact substring in the current committed code.
        Use for targeted edits instead of rewriting everything.
        YOU MUST call validate_code() immediately after this.

        Args:
            old_str (str): Exact string to find and replace. Must be unique in the code.
            new_str (str): Replacement string.
            description (str): Brief description of what this change does.
        """
        current = code_state.get("code", "")
        if not current:
            return "Error: No committed code exists yet. Use commit_code first."

        count = current.count(old_str)
        if count == 0:
            return "Error: old_str not found in current code. Make sure it matches exactly."
        if count > 1:
            return f"Error: old_str matches {count} times. Provide a more unique string."

        new_code = current.replace(old_str, new_str, 1)
        code_state["code"] = new_code

        await queue.put({
            "type": "code_update",
            "code": new_code,
            "library": code_state.get("library", "gsap"),
            "mode": "patch",
        })

        return (
            f"Applied edit: {description}. "
            "YOU MUST NOW call validate_code() immediately."
        )

    async def validate_code() -> str:
        """
        Runs static checks on the current animation code.
        Returns ok=true when there are no errors.
        Warnings may still exist even when ok=true — fix all warnings before summarizing.
        YOU MUST NOT finish until validate_code returns ok=true.
        """
        current = code_state.get("code", "")
        if not current:
            return "No code to validate. Call commit_code first."

        result = _validate(current, code_state.get("library", "gsap"))

        lines: list[str] = [f"ok: {str(result['ok']).lower()}"]
        if result["errors"]:
            lines.append("errors:\n" + "\n".join(f"  - {e}" for e in result["errors"]))
        if result["warnings"]:
            lines.append("warnings:\n" + "\n".join(f"  - {w}" for w in result["warnings"]))

        if result["ok"] and not result["warnings"]:
            lines.append("All checks passed. You may now summarize.")
        elif result["ok"] and result["warnings"]:
            lines.append("ok=true but warnings exist. Fix the warnings with str_replace, then call validate_code again.")

        return "\n".join(lines)

    return [read_code, commit_code, str_replace, validate_code]
