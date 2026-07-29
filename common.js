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

  function resize() {
    canvas.width = Math.max(2, Math.floor(window.innerWidth * density));
    canvas.height = Math.max(2, Math.floor(window.innerHeight * density));
  }
  let last = 0;
  function draw(t) {
    requestAnimationFrame(draw);
    if (t - last < 66) return;
    last = t;
    const img = ctx.createImageData(canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.random() * 255;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 8 + Math.random() * 52;
    }
    ctx.putImageData(img, 0, 0);
  }
  resize();
  requestAnimationFrame(draw);
  window.addEventListener("resize", resize);
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
