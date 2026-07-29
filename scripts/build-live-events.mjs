/* =========================================================
   スプレッドシートの公開CSVを取得して data/live-events.json を生成する。
   GitHub Actions (.github/workflows/sync-live-info.yml) から実行される。
   ローカル実行:  SHEET_CSV_URL="https://..." node scripts/build-live-events.mjs

   SHEET_CSV_URL はカンマ・空白区切りで複数指定できる。
   （手入力タブ＋Googleフォームの回答タブ、のように分かれている場合に使う）
   ========================================================= */
import { writeFile, readFile } from "node:fs/promises";

const CSV_URLS = String(process.env.SHEET_CSV_URL || "")
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter(Boolean);
const OUT_PATH = new URL("../data/live-events.json", import.meta.url);

if (!CSV_URLS.length) {
  console.error("SHEET_CSV_URL が設定されていません。");
  process.exit(1);
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    const next = csv[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }

  row.push(value);
  rows.push(row);
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

const normalizeHeader = (v) => String(v || "").trim().replace(/\s+/g, "").toLowerCase();

function getCell(row, headers, names) {
  for (const name of names) {
    const index = headers.indexOf(normalizeHeader(name));
    if (index >= 0) return String(row[index] || "").trim();
  }
  return "";
}

function toBoolean(value) {
  const v = String(value || "").trim().toLowerCase();
  return ["true", "1", "yes", "y", "公開", "表示", "published"].includes(v);
}

// 「公開」列そのものが無いシート（Googleフォームの回答タブなど）は全行を公開扱いにする
function hasPublishedColumn(headers) {
  return ["published", "公開", "表示"].some((name) => headers.includes(normalizeHeader(name)));
}

function normalizeDate(value) {
  const raw = String(value || "").trim();
  const m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return raw;
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// 曜日が空欄なら日付から自動で求める（スマホ入力の手数を減らすため）
function resolveWeekday(input, date) {
  const given = String(input || "").trim();
  if (given) return given;
  const m = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? "" : WEEKDAYS[d.getUTCDay()];
}

/* ---------- 告知ツイートからフライヤー画像と本文を取得する ---------- */

const FX_HOST = "https://api.fxtwitter.com";
const TWEET_URL_RE = /^https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i;
const IMAGE_HOST_PREFIX = "https://pbs.twimg.com/";
const FETCH_TIMEOUT_MS = 8000;

async function fetchTweetEmbed(tweetUrl) {
  const match = TWEET_URL_RE.exec(String(tweetUrl || "").trim());
  if (!match) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${FX_HOST}/${match[1]}/status/${match[2]}`, { signal: controller.signal });
    if (!res.ok) return null;

    const data = await res.json();
    const tweet = data && data.tweet;
    if (!tweet) return null;

    const photo = tweet.media && Array.isArray(tweet.media.photos) ? tweet.media.photos[0] : null;
    const imageUrl = photo && typeof photo.url === "string" && photo.url.startsWith(IMAGE_HOST_PREFIX) ? photo.url : "";

    // 横長フライヤーは横幅いっぱいで見せたいので寸法も持っておく
    const embed = {
      text: String(tweet.text || ""),
      imageUrl,
      url: String(tweet.url || tweetUrl),
    };
    if (imageUrl && Number.isFinite(photo.width) && Number.isFinite(photo.height)) {
      embed.imageWidth = photo.width;
      embed.imageHeight = photo.height;
    }
    return embed;
  } catch {
    return null; // 取得できなければ埋め込みなしで続行する
  } finally {
    clearTimeout(timer);
  }
}

async function loadEvents(url, sourceIndex) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const rows = parseCsv(await response.text());
  if (rows.length < 2) throw new Error("行が足りません（見出しだけ、または空）");

  const headers = rows[0].map(normalizeHeader);
  if (!headers.includes("日付") && !headers.includes("date")) {
    throw new Error("見出し行に『日付』が見つかりません");
  }

  // 「公開」列が無いタブ（フォームの回答など）は全行を公開扱いにする
  const usePublishedColumn = hasPublishedColumn(headers);

  return rows.slice(1).map((row, index) => {
    const date = normalizeDate(getCell(row, headers, ["date", "日付"]));
    const venue = getCell(row, headers, ["venue", "会場"]);
    const title = getCell(row, headers, ["title", "タイトル"]);
    return {
      id: getCell(row, headers, ["id", "ID"]) ||
        [date, venue, title, `${sourceIndex}-${index + 1}`].filter(Boolean).join("-"),
      published: usePublishedColumn ? toBoolean(getCell(row, headers, ["published", "公開", "表示"])) : true,
      date,
      weekday: resolveWeekday(getCell(row, headers, ["weekday", "曜日"]), date),
      venue,
      title,
      detail: getCell(row, headers, ["detail", "詳細"]),
      ticketUrl: getCell(row, headers, ["ticketUrl", "ticket", "チケットURL", "予約URL"]),
      tweetUrl: getCell(row, headers, ["tweetUrl", "tweet", "ツイートURL", "告知ツイートURL"]),
      note: getCell(row, headers, ["note", "備考", "メモ"]),
    };
  }).filter((event) => event.published === true && event.date);
}

// 公開=TRUE の行だけを書き出す（非公開行はリポジトリにも残さない）
const events = [];
for (const [index, url] of CSV_URLS.entries()) {
  try {
    const loaded = await loadEvents(url, index + 1);
    console.log(`取得: ${loaded.length}件 (${index + 1}/${CSV_URLS.length})`);
    events.push(...loaded);
  } catch (error) {
    // 1つでも取れなければ既存JSONを壊さずに中断する
    console.error(`シートの取得に失敗しました (${index + 1}/${CSV_URLS.length}): ${error.message}`);
    process.exit(1);
  }
}
events.sort((a, b) => String(a.date).localeCompare(String(b.date)));

// 告知ツイートがある公演にフライヤー画像・本文を付ける
const enriched = await Promise.all(
  events.map(async (event) => {
    if (!event.tweetUrl) return event;
    const tweetEmbed = await fetchTweetEmbed(event.tweetUrl);
    if (!tweetEmbed) {
      console.warn(`ツイートを取得できませんでした: ${event.tweetUrl}`);
      return event;
    }
    return { ...event, tweetEmbed };
  })
);

const payload = {
  schemaVersion: 1,
  source: "google-sheet",
  events: enriched,
};

const next = JSON.stringify(payload, null, 2) + "\n";

let current = "";
try {
  current = await readFile(OUT_PATH, "utf8");
} catch {
  /* 初回は存在しない */
}

const embedCount = enriched.filter((e) => e.tweetEmbed).length;

if (current === next) {
  console.log(`変更なし（${events.length}件 / 埋め込み${embedCount}件）`);
} else {
  await writeFile(OUT_PATH, next, "utf8");
  console.log(`data/live-events.json を更新しました（${events.length}件 / 埋め込み${embedCount}件）`);
}
