/* =========================================================
   XIAO — official site interactions
   ========================================================= */

/* ---------- YouTube playlist preview ---------- */
const PLAYLIST_ID = "PLXcNOFx8ryDIF2CMmRACsHkOPPiezLnpn";
const INITIAL_VIDEO_TITLE = /MONOCHROME/i;
const currentTitle = document.querySelector("#currentTitle");
const railTrack = document.querySelector("#railTrack");

let player = null;
let videoIds = [];
let initialVideoSet = false;
let userSelectedVideo = false;

/* load IFrame API */
(function loadYT() {
  const s = document.createElement("script");
  s.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(s);
})();

window.onYouTubeIframeAPIReady = function () {
  player = new YT.Player("ytplayer", {
    width: "100%",
    height: "100%",
    playerVars: {
      listType: "playlist",
      list: PLAYLIST_ID,
      rel: 0,
      modestbranding: 1,
      autoplay: 0,
      playsinline: 1,
    },
    events: { onReady: onPlayerReady, onStateChange: onPlayerState },
  });
};

function onPlayerReady() {
  collectPlaylist(0);
}

/* getPlaylist can be momentarily null right after ready — retry a few times */
function collectPlaylist(attempt) {
  const list = player.getPlaylist && player.getPlaylist();
  if (list && list.length) {
    videoIds = list;
    buildRail();
    updateNowPlaying();
  } else if (attempt < 12) {
    setTimeout(() => collectPlaylist(attempt + 1), 400);
  }
}

function buildRail() {
  railTrack.innerHTML = "";
  const make = (id, index, active) => {
    const btn = document.createElement("button");
    btn.className = "thumb" + (active ? " is-active" : "");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.dataset.index = index;
    btn.innerHTML =
      `<span class="thumb__img" style="--thumb:url('https://img.youtube.com/vi/${id}/hqdefault.jpg')"></span>` +
      `<span class="thumb__cap"><span class="thumb__title" data-cap>TRACK ${String(index + 1).padStart(2, "0")}</span></span>`;
    return btn;
  };
  // duplicate the set so the auto-scroll loop is seamless
  [...videoIds, ...videoIds].forEach((id, i) => {
    const index = i % videoIds.length;
    railTrack.appendChild(make(id, index, i === 0));
  });
  // fetch real titles (best-effort; falls back to TRACK NN)
  videoIds.forEach((id, index) => fetchTitle(id, index));
}

async function fetchTitle(id, index) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=https://youtu.be/${id}`
    );
    if (!res.ok) return;
    const data = await res.json();
    if (!data.title) return;
    railTrack
      .querySelectorAll(`.thumb[data-index="${index}"] [data-cap]`)
      .forEach((el) => (el.textContent = data.title));
    if (!initialVideoSet && !userSelectedVideo && INITIAL_VIDEO_TITLE.test(data.title)) {
      initialVideoSet = true;
      player.cuePlaylist({ listType: "playlist", list: PLAYLIST_ID, index });
      currentTitle.textContent = data.title;
      setActiveThumb(index);
      return;
    }
    if (index === currentIndex()) currentTitle.textContent = data.title;
  } catch (e) {
    /* CORS / offline — keep TRACK NN */
  }
}

function currentIndex() {
  return (player.getPlaylistIndex && player.getPlaylistIndex()) || 0;
}

function updateNowPlaying() {
  const idx = currentIndex();
  const data = player.getVideoData && player.getVideoData();
  if (data && data.title) currentTitle.textContent = data.title;
  setActiveThumb(idx);
}

function setActiveThumb(idx) {
  railTrack.querySelectorAll(".thumb").forEach((t) => {
    const on = Number(t.dataset.index) === idx;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
}

function onPlayerState() {
  updateNowPlaying();
}

/* click a thumbnail -> play it in the top preview */
railTrack.addEventListener("click", (e) => {
  if (Number(railTrack.dataset.draggedAt || 0) + 250 > Date.now()) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const btn = e.target.closest(".thumb");
  if (!btn || !player) return;
  userSelectedVideo = true;
  player.playVideoAt(Number(btn.dataset.index));
});

/* drag or Shift-wheel the flowing rail by moving the animation playhead */
(function railManualScroll() {
  const rail = document.querySelector(".rail");
  if (!rail || !railTrack) return;

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let dragging = false;

  const railAnimation = () =>
    railTrack.getAnimations().find((animation) => animation.animationName === "rail-flow") ||
    railTrack.getAnimations()[0];

  const railDistance = () => {
    const gap = parseFloat(getComputedStyle(rail).getPropertyValue("--rail-gap")) || 0;
    return railTrack.scrollWidth / 2 + gap / 2;
  };

  const wrapTime = (time, duration) => ((time % duration) + duration) % duration;

  const moveAnimationBy = (deltaX) => {
    const animation = railAnimation();
    if (!animation) return false;
    const timing = animation.effect.getTiming();
    const duration = Number(timing.duration) || 72000;
    const distance = railDistance();
    if (!distance) return false;
    animation.currentTime = wrapTime((animation.currentTime || 0) + (deltaX / distance) * duration, duration);
    return true;
  };

  rail.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const animation = railAnimation();
    if (!animation) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startTime = animation.currentTime || 0;
    dragging = false;
  });

  rail.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging && Math.abs(dx) < 8) return;
    if (!dragging && Math.abs(dy) > Math.abs(dx)) {
      pointerId = null;
      return;
    }

    const animation = railAnimation();
    if (!animation) return;
    const timing = animation.effect.getTiming();
    const duration = Number(timing.duration) || 72000;
    const distance = railDistance();
    if (!distance) return;

    if (!dragging) {
      dragging = true;
      rail.classList.add("is-dragging");
      rail.setPointerCapture(e.pointerId);
      animation.pause();
    }

    e.preventDefault();
    animation.currentTime = wrapTime(startTime - (dx / distance) * duration, duration);
  });

  const endDrag = (e) => {
    if (e.pointerId !== pointerId) return;
    const animation = railAnimation();
    if (dragging) {
      railTrack.dataset.draggedAt = String(Date.now());
      rail.classList.remove("is-dragging");
      if (animation) animation.play();
    }
    pointerId = null;
    dragging = false;
  };

  rail.addEventListener("pointerup", endDrag);
  rail.addEventListener("pointercancel", endDrag);

  rail.addEventListener("wheel", (e) => {
    if (!e.shiftKey) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!delta) return;
    if (!moveAnimationBy(delta)) return;
    e.preventDefault();
  }, { passive: false });
})();

/* ---------- intro loader ---------- */
(function intro() {
  const intro = document.querySelector("#intro");
  const bar = document.querySelector("#introBar");
  const count = document.querySelector("#introCount");
  if (!intro) return;

  // play once per session; skip entirely when embedded in a preview iframe
  const embedded = window.self !== window.top;
  const replayIntro = new URLSearchParams(window.location.search).get("intro") === "1";
  if (embedded || (!replayIntro && sessionStorage.getItem("introDone"))) {
    intro.classList.add("is-hidden");
    intro.remove();
    return;
  }

  let p = 0;
  const finish = () => {
    if (replayIntro) {
      bar.style.setProperty("--p", "100%");
      count.textContent = "100%";
      return;
    }
    intro.classList.add("is-hidden");
    if (!replayIntro) sessionStorage.setItem("introDone", "1");
    setTimeout(() => intro.remove(), 800);
  };
  const tick = () => {
    p += Math.random() * 9 + 3;
    if (p >= 100) p = 100;
    bar.style.setProperty("--p", p + "%");
    count.textContent = `${String(Math.floor(p)).padStart(3, "0")}%`;
    if (p < 100) setTimeout(tick, 70 + Math.random() * 90);
    else setTimeout(finish, 360);
  };
  setTimeout(tick, 280);
  intro.addEventListener("click", finish);
})();

/* ---------- background TV static ---------- */
(function staticNoise() {
  const canvas = document.querySelector("#staticCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const density = 0.55; // higher = finer grain

  function resize() {
    canvas.width = Math.max(2, Math.floor(window.innerWidth * density));
    canvas.height = Math.max(2, Math.floor(window.innerHeight * density));
  }
  // throttle to ~15fps for a slower analog flicker
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
      // thinner, more subtle static grains
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
