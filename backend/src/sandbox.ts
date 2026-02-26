/**
 * 把用户的动画代码包裹成完整 HTML
 * 注入时间劫持脚本，让 GSAP/Anime.js/PixiJS/Three.js/Canvas 2D 可以被精确 seek
 */

export interface SandboxOptions {
  width: number;
  height: number;
  library: "gsap" | "anime" | "pixi" | "three" | "auto";
}

const TIME_HIJACK_SCRIPT = `
<script>
  window.__virtualTime = 0;

  // 劫持 Date
  Date.now = () => window.__virtualTime * 1000;

  // 劫持 performance.now
  performance.now = () => window.__virtualTime * 1000;

  // 劫持 RAF：排队而不是立即执行，由 __seekTo 统一 flush
  let __rafCallbacks = new Map();
  let __rafId = 0;
  window.requestAnimationFrame = (cb) => {
    const id = ++__rafId;
    __rafCallbacks.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => { __rafCallbacks.delete(id); };

  // seek 函数：外部调用来跳到指定时间（秒）
  window.__seekTo = function(timeInSeconds) {
    window.__virtualTime = timeInSeconds;
    const t = timeInSeconds * 1000;

    // GSAP seek
    if (window.gsap) {
      gsap.globalTimeline.seek(timeInSeconds, false);
    }

    // Anime.js seek
    if (window.__animeInstances && window.__animeInstances.length > 0) {
      window.__animeInstances.forEach(anim => {
        try { anim.seek(t); } catch(e) {}
      });
    }

    // PixiJS ticker seek
    if (window.__pixiApps && window.__pixiApps.length > 0) {
      window.__pixiApps.forEach(app => {
        try { app.ticker.update(t); } catch(e) {}
      });
    }

    // Canvas 2D / Three.js / 其他 RAF 循环 — flush 所有排队的回调
    const cbs = [...__rafCallbacks.values()];
    __rafCallbacks.clear();
    cbs.forEach(cb => { try { cb(t); } catch(e) {} });
  };

  // 收集 anime 实例
  window.__animeInstances = [];
  // 收集 PixiJS Application 实例
  window.__pixiApps = [];
</script>
`;

const GSAP_CDN = `<script src="http://localhost:3001/libs/gsap.min.js"></script>`;

const ANIME_CDN = `<script src="http://localhost:3001/libs/anime.min.js"></script>
<script>
  (function() {
    const _anime = window.anime;
    window.anime = function(params) {
      const instance = _anime({ ...params, autoplay: false });
      window.__animeInstances.push(instance);
      return instance;
    };
    Object.assign(window.anime, _anime);
  })();
</script>`;

// PixiJS：加载后拦截 Application 构造函数，自动停止 ticker 并收集实例
const PIXI_CDN = `${GSAP_CDN}
<script src="http://localhost:3001/libs/pixi.min.js"></script>
<script>
  (function() {
    const _App = PIXI.Application;
    function PatchedApp(options) {
      const app = new _App(options);
      app.ticker.stop();
      window.__pixiApps.push(app);
      return app;
    }
    PatchedApp.prototype = _App.prototype;
    PIXI.Application = PatchedApp;
  })();
</script>`;

// Three.js：RAF 劫持已经处理 render loop，直接加载即可
const THREE_CDN = `${GSAP_CDN}
<script src="http://localhost:3001/libs/three.min.js"></script>`;

function detectLibrary(code: string): "gsap" | "anime" | "pixi" | "three" {
  if (code.includes("THREE") || code.includes("three.js")) return "three";
  if (code.includes("PIXI") || code.includes("pixi")) return "pixi";
  if (code.includes("anime(") || code.includes("anime.")) return "anime";
  return "gsap";
}

export function buildSandboxHtml(userCode: string, options: SandboxOptions): string {
  const lib = options.library === "auto" ? detectLibrary(userCode) : options.library;
  const libScript = lib === "anime" ? ANIME_CDN
    : lib === "pixi" ? PIXI_CDN
    : lib === "three" ? THREE_CDN
    : GSAP_CDN;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background: #000;
    }
  </style>
  ${TIME_HIJACK_SCRIPT}
  <script>
    window.CANVAS_WIDTH = ${options.width};
    window.CANVAS_HEIGHT = ${options.height};
    window.SCALE = Math.min(${options.width} / 1280, ${options.height} / 720);
  </script>
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
