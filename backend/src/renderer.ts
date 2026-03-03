import puppeteer, { Browser, Page } from "puppeteer-core";
import path from "path";
import fs from "fs";
import { buildSandboxHtml, SandboxOptions } from "./sandbox";

const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface RenderOptions extends SandboxOptions {
  fps: number;
  duration: number; // 秒
  outputDir: string;
  onProgress?: (frame: number, total: number) => void;
  signal?: AbortSignal;
}

let browserInstance: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.connected) {
    browserInstance = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      protocolTimeout: 120000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    });
  }
  return browserInstance;
}

export async function renderFrames(
  userCode: string,
  options: RenderOptions
): Promise<string[]> {
  const { fps, duration, outputDir, width, height, onProgress, signal } = options;
  const totalFrames = Math.ceil(fps * duration);

  fs.mkdirSync(outputDir, { recursive: true });

  const html = buildSandboxHtml(userCode, options);
  const browser = await getBrowser();
  const page: Page = await browser.newPage();

  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    // 加载 HTML（data URL 方式，不需要起 HTTP server）
    await page.setContent(html, { waitUntil: "load", timeout: 60000 });

    const framePaths: string[] = [];

    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw new Error("Render stopped");
      const t = i / fps;

      // seek 到当前帧时间
      await page.evaluate((time: number) => {
        (globalThis as any).__seekTo(time);
      }, t);

      // 等一个 microtask tick，让 DOM 更新
      await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));

      const framePath = path.join(outputDir, `frame_${String(i).padStart(6, "0")}.png`);

      // 截图加重试，偶发重帧超时时自动恢复
      let attempts = 0;
      while (true) {
        try {
          if (signal?.aborted) throw new Error("Render stopped");
          await page.screenshot({ path: framePath as `${string}.png`, type: "png" });
          break;
        } catch (err: any) {
          attempts++;
          if (attempts >= 3) throw err;
          // 等 500ms 再试
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      framePaths.push(framePath);

      onProgress?.(i + 1, totalFrames);
    }

    return framePaths;
  } finally {
    await page.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}
