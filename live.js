/* =========================================================
   XIAO — Live Info
   データ供給の優先順位:
     1. /api/live            … Google Sheets 公開CSV を読むサーバー側API（未実装。連携時に追加）
     2. data/live-events.json … ローカルのフォールバックJSON
     3. EMBEDDED_FALLBACK     … file:// で開いた時のモック表示用
   受け取るJSONの形はminagireiの /api/live と同一:
     { schemaVersion, source, events: [{ id, published, date, weekday,
       venue, title, detail, ticketUrl, tweetUrl, note, tweetEmbed? }] }
   ========================================================= */
(function () {
  "use strict";

  const CONFIG = {
    apiUrl: "/api/live",
    fallbackJsonUrl: "data/live-events.json",
  };

  const EMBEDDED_FALLBACK = {
    schemaVersion: 1,
    source: "embedded",
    events: [
      {
        id: "sample-upcoming",
        published: true,
        date: "2026-08-16",
        weekday: "Sun",
        venue: "新宿SAMPLE HALL",
        title: "SAMPLE LIVE vol.01",
        detail: "対バン / 出演17:40〜",
        ticketUrl: "https://example.com/ticket/0816",
        tweetUrl: "",
        note: "※これはモックアップ用のサンプルデータです",
      },
      {
        id: "sample-past",
        published: true,
        date: "2026-06-21",
        weekday: "Sun",
        venue: "池袋SAMPLE LOUNGE",
        title: "SAMPLE NIGHT",
        detail: "対バン / 2部制",
        ticketUrl: "",
        tweetUrl: "",
        note: "",
      },
    ],
  };

  /* ---------- helpers ---------- */

  function parseDate(value) {
    const date = new Date(String(value || "") + "T00:00:00+09:00");
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(value) {
    const parts = String(value || "").split("-");
    if (parts.length !== 3) return value || "";
    return parts[0] + "." + parts[1] + "." + parts[2];
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function externalLink(href, label, className) {
    const a = el("a", className, label);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }

  /* ---------- card ---------- */

  function createItem(event, isPast, showEmbed) {
    const item = el("li", "live-item" + (isPast ? " is-past" : ""));

    const body = el("div", "live-item__body");

    // 日付ブロック
    const date = el("div", "live-date");
    date.appendChild(el("span", "live-date__ymd", formatDate(event.date)));
    const meta = el("span", "live-date__meta");
    if (event.weekday) meta.appendChild(el("span", "", event.weekday));
    meta.appendChild(el("span", "dot"));
    meta.appendChild(el("span", "", isPast ? "Archive" : "Upcoming"));
    date.appendChild(meta);

    // 本文
    const info = el("div", "live-info");
    info.appendChild(el("h3", "live-title", event.title || "未定"));
    const detail = [event.venue, event.detail].filter(Boolean).join(" / ");
    if (detail) info.appendChild(el("p", "live-meta", detail));
    if (event.note) info.appendChild(el("p", "live-note", event.note));

    // アクション
    const actions = el("div", "live-actions");
    if (event.ticketUrl) {
      actions.appendChild(externalLink(event.ticketUrl, "Ticket", "live-btn live-btn--primary"));
    }
    if (event.tweetUrl) {
      actions.appendChild(externalLink(event.tweetUrl, "Info on X", "live-btn"));
    }

    body.appendChild(date);
    body.appendChild(info);
    if (actions.childNodes.length) body.appendChild(actions);
    item.appendChild(body);

    // 告知ツイートの埋め込み（tweetEmbed があり、埋め込みを許可したリストのみ）
    if (showEmbed && !isPast && event.tweetEmbed) {
      const embed = el("div", "live-embed");
      if (event.tweetEmbed.imageUrl) {
        const img = document.createElement("img");
        img.className = "live-embed__img";
        img.src = event.tweetEmbed.imageUrl;
        img.alt = "告知フライヤー";
        img.loading = "lazy";

        // 横長フライヤーは横幅いっぱいに出し、本文をその下に置く
        const applyOrientation = (w, h) => {
          if (!w || !h) return;
          embed.classList.toggle("live-embed--wide", w / h >= 1.15);
        };
        applyOrientation(event.tweetEmbed.imageWidth, event.tweetEmbed.imageHeight);
        img.addEventListener("load", () => applyOrientation(img.naturalWidth, img.naturalHeight));

        embed.appendChild(img);
      }
      const textWrap = el("div");
      if (event.tweetEmbed.text) textWrap.appendChild(el("p", "live-embed__text", event.tweetEmbed.text));
      if (event.tweetEmbed.url) {
        textWrap.appendChild(externalLink(event.tweetEmbed.url, "View on X", "live-embed__link"));
      }
      embed.appendChild(textWrap);
      item.appendChild(embed);
    }

    return item;
  }

  /* ---------- render ---------- */

  function splitEvents(events) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const published = events.filter((event) => event && event.published === true);
    const key = (event) => {
      const date = parseDate(event.date);
      return date ? date.getTime() : 0;
    };

    const upcoming = published
      .filter((event) => {
        const date = parseDate(event.date);
        return date && date.getTime() >= today.getTime();
      })
      .sort((a, b) => key(a) - key(b));

    const past = published
      .filter((event) => {
        const date = parseDate(event.date);
        return !date || date.getTime() < today.getTime();
      })
      .sort((a, b) => key(b) - key(a));

    return { upcoming, past };
  }

  function renderList(list, events, isPast) {
    // data-live-limit="2" のように上限を指定できる（トップページの抜粋表示用）
    const total = events.length;
    // data-live-embed="off" のリストでは告知ツイートの埋め込みを出さない（トップの抜粋用）
    const showEmbed = list.getAttribute("data-live-embed") !== "off";
    const limitAttr = parseInt(list.getAttribute("data-live-limit"), 10);
    if (Number.isFinite(limitAttr) && limitAttr > 0) events = events.slice(0, limitAttr);

    list.replaceChildren();
    const countLabel = document.querySelector(
      '[data-live-count="' + list.getAttribute("data-live-list") + '"]'
    );
    if (countLabel) countLabel.textContent = String(total).padStart(2, "0");

    if (!events.length) {
      const empty = el("li");
      empty.appendChild(
        el("div", "live-empty", isPast ? "アーカイブはまだありません。" : "現在公開中のライブ予定はありません。")
      );
      list.appendChild(empty);
      return;
    }
    events.forEach((event) => list.appendChild(createItem(event, isPast, showEmbed)));
  }

  function render(payload) {
    const events = Array.isArray(payload.events) ? payload.events : [];
    const split = splitEvents(events);

    document.querySelectorAll("[data-live-list]").forEach((list) => {
      const type = list.getAttribute("data-live-list");
      if (type === "upcoming") renderList(list, split.upcoming, false);
      if (type === "past") renderList(list, split.past, true);
    });

    const source = document.querySelector("[data-live-source]");
    if (source) {
      const label =
        payload.source === "google-sheet"
          ? "Google Sheet"
          : payload.source === "local-json"
          ? "Local JSON (mock)"
          : payload.source === "fallback"
          ? "Fallback JSON"
          : "Embedded sample";
      source.innerHTML = "";
      source.appendChild(document.createTextNode("Data source: "));
      source.appendChild(el("b", "", label));
    }
  }

  /* ---------- load ---------- */

  function fetchJson(url) {
    return fetch(url, { cache: "no-cache" }).then((response) => {
      if (!response.ok) throw new Error("Request failed: " + response.status);
      return response.json();
    });
  }

  if (document.querySelector("[data-live-list]")) {
    fetchJson(CONFIG.apiUrl)
      .catch(() => fetchJson(CONFIG.fallbackJsonUrl))
      .catch(() => EMBEDDED_FALLBACK)
      .then(render)
      .catch(() => render(EMBEDDED_FALLBACK));
  }
})();
