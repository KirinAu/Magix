/**
 * 把用户的动画代码包裹成完整 HTML
 * 注入时间劫持脚本，让 GSAP/Anime.js 可以被精确 seek
 */

export interface SandboxOptions {
  width: number;
  height: number;
  library: "gsap" | "anime" | "auto";
}

const TIME_HIJACK_SCRIPT = `
<script>
  // 冻结真实时间，让动画库使用我们控制的虚拟时间
  window.__virtualTime = 0;

  // 劫持 Date
  const _DateNow = Date.now.bind(Date);
  Date.now = () => window.__virtualTime * 1000;

  // 劫持 performance.now
  const _perfNow = performance.now.bind(performance);
  performance.now = () => window.__virtualTime * 1000;

  // 劫持 requestAnimationFrame（防止动画自动播放）
  window.requestAnimationFrame = (cb) => {
    // 不自动执行，由外部 seek 控制
    return 0;
  };
  window.cancelAnimationFrame = () => {};

  // seek 函数：外部调用来跳到指定时间（秒）
  window.__seekTo = function(timeInSeconds) {
    window.__virtualTime = timeInSeconds;

    // GSAP seek
    if (window.gsap) {
      gsap.globalTimeline.seek(timeInSeconds, false);
    }

    // Anime.js seek
    if (window.__animeInstances && window.__animeInstances.length > 0) {
      window.__animeInstances.forEach(anim => {
        anim.seek(timeInSeconds * 1000);
      });
    }
  };

  // 拦截 anime() 调用，收集所有实例
  window.__animeInstances = [];
  document.addEventListener('__animeCreated', (e) => {
    window.__animeInstances.push(e.detail);
  });
</script>
`;

const GSAP_CDN = `<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>`;
const ANIME_CDN = `<script src="https://cdnjs.cloudflare.com/ajax/libs/animejs/3.2.2/anime.min.js"></script>
<script>
  // 包装 anime，自动收集实例
  document.addEventListener('DOMContentLoaded', () => {
    if (window.anime) {
      const _anime = window.anime;
      window.anime = function(params) {
        const instance = _anime({ ...params, autoplay: false });
        window.__animeInstances.push(instance);
        return instance;
      };
      Object.assign(window.anime, _anime);
    }
  });
</script>`;

function detectLibrary(code: string): "gsap" | "anime" {
  if (code.includes("gsap") || code.includes("TweenMax") || code.includes("TweenLite")) {
    return "gsap";
  }
  return "anime";
}

export function buildSandboxHtml(userCode: string, options: SandboxOptions): string {
  const lib = options.library === "auto" ? detectLibrary(userCode) : options.library;
  const libScript = lib === "gsap" ? GSAP_CDN : ANIME_CDN;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: ${options.width}px;
      height: ${options.height}px;
      overflow: hidden;
      background: #000;
    }
  </style>
  ${TIME_HIJACK_SCRIPT}
  ${libScript}
</head>
<body>
<script>
// ---- 用户代码开始 ----
${userCode}
// ---- 用户代码结束 ----
</script>
</body>
</html>`;
}
