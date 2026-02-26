import { getBrowser } from "./renderer";
import { buildSandboxHtml } from "./sandbox";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// ── 静态检查（不需要浏览器，毫秒级）────────────────────────────────
function staticCheck(code: string, library: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 语法检查（Function constructor）
  try {
    new Function(code);
  } catch (e: any) {
    errors.push(`Syntax error: ${e.message}`);
  }

  // import 语句
  if (/^\s*import\s+/m.test(code)) {
    errors.push("Code must not contain import statements");
  }

  // <script> 标签
  if (/<script/i.test(code)) {
    errors.push("Code must not contain <script> tags");
  }

  // Three.js 禁止 gsap.ticker.add
  if ((library === "three" || code.includes("THREE")) && code.includes("gsap.ticker.add")) {
    errors.push("Three.js code must NOT use gsap.ticker.add — use a RAF loop instead");
  }

  // cleanup block
  const hasCleanup =
    code.includes("gsap.killTweensOf") ||
    code.includes("cancelAnimationFrame") ||
    code.includes("globalTimeline.clear");
  if (!hasCleanup) {
    warnings.push("Missing cleanup block — add gsap.killTweensOf / cancelAnimationFrame at the top");
  }

  // CANVAS_WIDTH / CANVAS_HEIGHT
  if (!code.includes("CANVAS_WIDTH") && !code.includes("CANVAS_HEIGHT")) {
    warnings.push("Code does not reference CANVAS_WIDTH / CANVAS_HEIGHT — hardcoded sizes may break export");
  }

  return { errors, warnings };
}

// ── 运行时检查（puppeteer，捕获真实错误）────────────────────────────
async function runtimeCheck(
  code: string,
  library: string
): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const html = buildSandboxHtml(code, {
    width: 1280,
    height: 720,
    library: library as any,
  });

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    page.on("pageerror", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Runtime error: ${msg}`);
    });

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        warnings.push(`Console error: ${msg.text()}`);
      }
    });

    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load", timeout: 15000 });

    // 等初始化完成
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));

    // seek t=0 和 t=1s，触发动画逻辑
    await page.evaluate(() => {
      try { (globalThis as any).__seekTo(0); } catch (_) {}
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
    await page.evaluate(() => {
      try { (globalThis as any).__seekTo(1); } catch (_) {}
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
  } finally {
    await page.close();
  }

  return { errors, warnings };
}

// ── 对外接口 ─────────────────────────────────────────────────────────
export async function validateCode(
  code: string,
  library: string = "gsap"
): Promise<ValidationResult> {
  const { errors: sErr, warnings: sWarn } = staticCheck(code, library);

  // 有语法错误就不跑浏览器了
  if (sErr.some((e) => e.startsWith("Syntax"))) {
    return { ok: false, errors: sErr, warnings: sWarn };
  }

  let rErr: string[] = [];
  let rWarn: string[] = [];

  try {
    const r = await runtimeCheck(code, library);
    rErr = r.errors;
    rWarn = r.warnings;
  } catch (e: unknown) {
    rErr.push(`Validator internal error: ${e instanceof Error ? e.message : String(e)}`);
  }

  const allErrors = [...sErr, ...rErr];
  const allWarnings = [...sWarn, ...rWarn];

  return {
    ok: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}
