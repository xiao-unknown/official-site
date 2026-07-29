/* =========================================================
   スプレッドシートの公開CSVを取得して data/live-events.json を生成する。
   GitHub Actions (.github/workflows/sync-live-info.yml) から実行される。
   ローカル実行:  SHEET_CSV_URL="https://..." node scripts/build-live-events.mjs
   ========================================================= */
import { writeFile, readFile } from "node:fs/promises";

const CSV_URL = process.env.SHEET_CSV_URL;
const OUT_PATH = new URL("../data/live-events.json", import.meta.url);

if (!CSV_URL) {
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

    return {
      text: String(tweet.text || ""),
      imageUrl,
      url: String(tweet.url || tweetUrl),
    };
  } catch {
    return null; // 取得できなければ埋め込みなしで続行する
  } finally {
    clearTimeout(timer);
  }
}

const response = await fetch(CSV_URL, { redirect: "follow" });
if (!response.ok) {
  console.error(`シートの取得に失敗しました: HTTP ${response.status}`);
  process.exit(1);
}

const rows = parseCsv(await response.text());
if (rows.length < 2) {
  console.error("シートの行が足りません。既存のJSONを維持して終了します。");
  process.exit(1);
}

const headers = rows[0].map(normalizeHeader);
if (!headers.includes("日付") && !headers.includes("date")) {
  console.error("見出し行に『日付』が見つかりません。列構成が変わった可能性があります。");
  process.exit(1);
}

// 公開=TRUE の行だけを書き出す（非公開行はリポジトリにも残さない）
const events = rows.slice(1).map((row, index) => {
  const date = normalizeDate(getCell(row, headers, ["date", "日付"]));
  const venue = getCell(row, headers, ["venue", "会場"]);
  const title = getCell(row, headers, ["title", "タイトル"]);
  return {
    id: getCell(row, headers, ["id", "ID"]) || [date, venue, title, index + 1].filter(Boolean).join("-"),
    published: toBoolean(getCell(row, headers, ["published", "公開", "表示"])),
    date,
    weekday: resolveWeekday(getCell(row, headers, ["weekday", "曜日"]), date),
    venue,
    title,
    detail: getCell(row, headers, ["detail", "詳細"]),
    ticketUrl: getCell(row, headers, ["ticketUrl", "ticket", "チケットURL", "予約URL"]),
    tweetUrl: getCell(row, headers, ["tweetUrl", "tweet", "ツイートURL", "告知ツイートURL"]),
    note: getCell(row, headers, ["note", "備考", "メモ"]),
  };
}).filter((event) => event.published === true);

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
