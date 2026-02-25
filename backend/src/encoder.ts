import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs";

export interface EncodeOptions {
  framesDir: string;
  outputPath: string;
  fps: number;
  width: number;
  height: number;
}

export function encodeToMp4(options: EncodeOptions): Promise<string> {
  const { framesDir, outputPath, fps, width, height } = options;
  const inputPattern = path.join(framesDir, "frame_%06d.png");

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inputPattern)
      .inputOptions([`-framerate ${fps}`])
      .videoCodec("libx264")
      .outputOptions([
        "-pix_fmt yuv420p",       // 兼容性最好
        "-crf 18",                 // 高质量
        "-preset fast",
        `-vf scale=${width}:${height}`,
        "-movflags +faststart",    // 支持流式播放
      ])
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err))
      .run();
  });
}

export function cleanupFrames(framesDir: string): void {
  fs.rmSync(framesDir, { recursive: true, force: true });
}
