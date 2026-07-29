/* =========================================================
   XIAO — Movie page
   プレイリスト全曲をグリッド表示し、クリックで上部プレイヤーに読み込む
   ========================================================= */
(function () {
  "use strict";

  const PLAYLIST_ID = "PLXcNOFx8ryDIF2CMmRACsHkOPPiezLnpn";
  const currentTitle = document.querySelector("#currentTitle");
  const grid = document.querySelector("#movieGrid");
  const countLabel = document.querySelector("[data-movie-count]");
  if (!grid) return;

  let player = null;
  let videoIds = [];

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
      events: { onReady: () => collectPlaylist(0), onStateChange: updateNowPlaying },
    });
  };

  /* getPlaylist は ready 直後に null を返すことがあるのでリトライ */
  function collectPlaylist(attempt) {
    const list = player.getPlaylist && player.getPlaylist();
    if (list && list.length) {
      videoIds = list;
      buildGrid();
      updateNowPlaying();
    } else if (attempt < 12) {
      setTimeout(() => collectPlaylist(attempt + 1), 400);
    }
  }

  function buildGrid() {
    grid.innerHTML = "";
    if (countLabel) countLabel.textContent = String(videoIds.length).padStart(2, "0");

    videoIds.forEach((id, index) => {
      const btn = document.createElement("button");
      btn.className = "movie-card";
      btn.type = "button";
      btn.dataset.index = String(index);
      btn.innerHTML =
        `<span class="movie-card__img" style="--thumb:url('https://img.youtube.com/vi/${id}/hqdefault.jpg')">` +
        `<span class="movie-card__no">${String(index + 1).padStart(2, "0")}</span></span>` +
        `<span class="movie-card__cap"><span class="movie-card__title" data-cap>TRACK ${String(index + 1).padStart(2, "0")}</span></span>`;
      grid.appendChild(btn);
      fetchTitle(id, index);
    });
  }

  async function fetchTitle(id, index) {
    try {
      const res = await fetch(`https://www.youtube.com/oembed?format=json&url=https://youtu.be/${id}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.title) return;
      grid
        .querySelectorAll(`.movie-card[data-index="${index}"] [data-cap]`)
        .forEach((elm) => (elm.textContent = data.title));
      if (currentTitle && index === currentIndex()) currentTitle.textContent = data.title;
    } catch (e) {
      /* CORS / offline — TRACK NN のまま */
    }
  }

  function currentIndex() {
    return (player && player.getPlaylistIndex && player.getPlaylistIndex()) || 0;
  }

  function updateNowPlaying() {
    const idx = currentIndex();
    const data = player && player.getVideoData && player.getVideoData();
    if (currentTitle && data && data.title) currentTitle.textContent = data.title;
    grid.querySelectorAll(".movie-card").forEach((card) => {
      card.classList.toggle("is-active", Number(card.dataset.index) === idx);
    });
  }

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest(".movie-card");
    if (!btn || !player) return;
    player.playVideoAt(Number(btn.dataset.index));
    document.querySelector(".movie__frame").scrollIntoView({ behavior: "smooth", block: "center" });
  });
})();
