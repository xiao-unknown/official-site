/* =========================================================
   XIAO — 下層ページ共通 interactions
   （背景ノイズ / スライドインサイドバー。トップの script.js と同挙動）
   ========================================================= */

/* ---------- background TV static ---------- */
(function staticNoise() {
  const canvas = document.querySelector("#staticCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const density = 0.55;
  const FRAME_COUNT = 8; // 事前生成フレームを巡回（毎フレーム生成はCPU負荷が高いため）
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let frames = [];

  function makeFrame(w, h) {
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const octx = off.getContext("2d");
    const img = octx.createImageData(w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.random() * 255;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 8 + Math.random() * 52;
    }
    octx.putImageData(img, 0, 0);
    return off;
  }

  function rebuild() {
    const w = Math.max(2, Math.floor(window.innerWidth * density));
    const h = Math.max(2, Math.floor(window.innerHeight * density));
    canvas.width = w;
    canvas.height = h;
    frames = [];
    for (let i = 0; i < FRAME_COUNT; i++) frames.push(makeFrame(w, h));
    ctx.drawImage(frames[0], 0, 0);
  }

  let last = 0;
  let frameIndex = 0;
  function draw(t) {
    requestAnimationFrame(draw);
    if (reduceMotion.matches) return; // 静止1フレームのまま
    if (t - last < 66) return;
    last = t;
    frameIndex = (frameIndex + 1) % frames.length;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frames[frameIndex], 0, 0);
  }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rebuild, 200);
  });

  rebuild();
  requestAnimationFrame(draw);
})();

/* ---------- slide-in sidebar ---------- */
(function sidebar() {
  const btn = document.querySelector("#menuButton");
  const panel = document.querySelector("#sidebar");
  const backdrop = document.querySelector("#navBackdrop");
  const closeBtn = document.querySelector("#navClose");
  if (!btn || !panel) return;

  const open = () => {
    document.body.classList.add("nav-open");
    panel.setAttribute("aria-hidden", "false");
    btn.setAttribute("aria-expanded", "true");
  };
  const close = () => {
    document.body.classList.remove("nav-open");
    panel.setAttribute("aria-hidden", "true");
    btn.setAttribute("aria-expanded", "false");
  };
  const toggle = () =>
    document.body.classList.contains("nav-open") ? close() : open();

  btn.addEventListener("click", toggle);
  if (closeBtn) closeBtn.addEventListener("click", close);
  if (backdrop) backdrop.addEventListener("click", close);
  panel.querySelectorAll("[data-nav]").forEach((a) => a.addEventListener("click", close));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
})();
