import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs";

export interface EncodeOptions {
  framesDir: string;
  outputPath: string;
  fps: number;
  width: number;
  height: number;
  signal?: AbortSignal;
}

export function encodeToMp4(options: EncodeOptions): Promise<string> {
  const { framesDir, outputPath, fps, width, height, signal } = options;
  const inputPattern = path.join(framesDir, "frame_%06d.png");

  return new Promise((resolve, reject) => {
    const command = ffmpeg()
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
      .on("error", (err) => reject(err));

    command.run();

    if (signal) {
      const onAbort = () => {
        try {
          command.kill("SIGKILL");
        } catch {}
        reject(new Error("Render stopped"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function cleanupFrames(framesDir: string): void {
  fs.rmSync(framesDir, { recursive: true, force: true });
}

/**
 * 获取视频时长（秒）
 */
export function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration ?? 0);
    });
  });
}

/**
 * 截取视频片段
 */
export function trimVideo(options: {
  inputPath: string;
  outputPath: string;
  startTime: number;
  endTime: number;
  signal?: AbortSignal;
}): Promise<string> {
  const { inputPath, outputPath, startTime, endTime, signal } = options;
  const duration = endTime - startTime;

  return new Promise((resolve, reject) => {
    const command = ffmpeg()
      .input(inputPath)
      .inputOptions([`-ss ${startTime}`])
      .outputOptions([
        `-t ${duration}`,
        "-c copy",
        "-avoid_negative_ts make_zero",
      ])
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err));

    command.run();

    if (signal) {
      const onAbort = () => {
        try { command.kill("SIGKILL"); } catch {}
        reject(new Error("Trim stopped"));
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * 拼接多个视频片段（使用 FFmpeg concat demuxer）
 */
export function concatVideos(options: {
  clips: Array<{ filePath: string; trimStart: number; trimEnd: number }>;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { clips, outputPath, signal } = options;
  const tmpDir = path.join(path.dirname(outputPath), `_concat_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // 先把每个片段截取出来
  return (async () => {
    const trimmedPaths: string[] = [];

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const trimmedPath = path.join(tmpDir, `part_${i}.mp4`);

      if (clip.trimStart > 0 || clip.trimEnd > 0) {
        await trimVideo({
          inputPath: clip.filePath,
          outputPath: trimmedPath,
          startTime: clip.trimStart,
          endTime: clip.trimEnd,
          signal,
        });
      } else {
        // 不需要截取，直接复制
        fs.copyFileSync(clip.filePath, trimmedPath);
      }
      trimmedPaths.push(trimmedPath);
    }

    // 生成 concat 列表文件
    const listFile = path.join(tmpDir, "list.txt");
    const listContent = trimmedPaths.map((p) => `file '${p}'`).join("\n");
    fs.writeFileSync(listFile, listContent, "utf-8");

    // 拼接
    await new Promise<void>((resolve, reject) => {
      const command = ffmpeg()
        .input(listFile)
        .inputOptions(["-f concat", "-safe 0"])
        .outputOptions([
          "-c copy",
          "-movflags +faststart",
        ])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err) => reject(err));

      command.run();

      if (signal) {
        const onAbort = () => {
          try { command.kill("SIGKILL"); } catch {}
          reject(new Error("Concat stopped"));
        };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    // 清理临时文件
    fs.rmSync(tmpDir, { recursive: true, force: true });

    return outputPath;
  })();
}
