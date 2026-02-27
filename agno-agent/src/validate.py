"""
Static validation for animation code.
Mirrors the checks in the TS backend validator.ts.
Runtime (Puppeteer) check is skipped here; the TS backend can do it separately.
"""
from __future__ import annotations
import re


def validate_code(code: str, library: str) -> dict:
    errors: list[str] = []
    warnings: list[str] = []

    # ── Syntax check ────────────────────────────────────────────────────────
    try:
        compile(code, "<animation>", "exec")
    except SyntaxError as e:
        errors.append(f"Syntax error: {e.msg} (line {e.lineno})")

    # ── import statements ───────────────────────────────────────────────────
    if re.search(r"^\s*import\s+", code, re.MULTILINE):
        errors.append("Code must not contain import statements")

    # ── <script> tags ───────────────────────────────────────────────────────
    if re.search(r"<script", code, re.IGNORECASE):
        errors.append("Code must not contain <script> tags")

    # ── Three.js + gsap.ticker.add ──────────────────────────────────────────
    if (library == "three" or "THREE" in code) and "gsap.ticker.add" in code:
        errors.append("Three.js code must NOT use gsap.ticker.add — use a RAF loop instead")

    # ── Cleanup block ───────────────────────────────────────────────────────
    has_cleanup = (
        "gsap.killTweensOf" in code
        or "cancelAnimationFrame" in code
        or "globalTimeline.clear" in code
    )
    if not has_cleanup:
        warnings.append("Missing cleanup block — add gsap.killTweensOf / cancelAnimationFrame at the top")

    # ── Canvas size refs ────────────────────────────────────────────────────
    if "CANVAS_WIDTH" not in code and "CANVAS_HEIGHT" not in code:
        warnings.append("Code does not reference CANVAS_WIDTH / CANVAS_HEIGHT — hardcoded sizes may break export")

    return {
        "ok": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
    }
