/* =========================================================
   /api/live — Google スプレッドシートの公開CSVを読んでJSONで返す
   環境変数 LIVE_SHEET_CSV_URL が未設定・取得失敗のときは
   data/live-events.json をフォールバックとして返す。
   公開列が TRUE の行だけを返す（非公開行はブラウザに届かない）。
   ========================================================= */
const fallbackData = require("../data/live-events.json");

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

function normalizeHeader(value) {
  return String(value || "").trim().replace(/\s+/g, "").toLowerCase();
}

function getCell(row, headers, names) {
  for (const name of names) {
    const index = headers.indexOf(normalizeHeader(name));
    if (index >= 0) return String(row[index] || "").trim();
  }
  return "";
}

function toBoolean(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return false;
  return ["true", "1", "yes", "y", "公開", "表示", "published"].includes(normalized);
}

function normalizeDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  // 2026/08/16 や 2026.8.16 も 2026-08-16 に揃える
  const m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return raw;
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// 曜日が空欄なら日付から自動で求める
function resolveWeekday(input, date) {
  const given = String(input || "").trim();
  if (given) return given;
  const m = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? "" : WEEKDAYS[d.getUTCDay()];
}

function toEvent(row, headers, index) {
  const date = normalizeDate(getCell(row, headers, ["date", "日付"]));
  const venue = getCell(row, headers, ["venue", "会場"]);
  const title = getCell(row, headers, ["title", "タイトル"]);

  return {
    id: getCell(row, headers, ["id", "ID"]) || [date, venue, title, index].filter(Boolean).join("-"),
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
}

function publicEvents(events) {
  return Array.isArray(events) ? events.filter((event) => event.published === true) : [];
}

function sendJson(response, payload, cacheControl) {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", cacheControl || "public, s-maxage=60, stale-while-revalidate=300");
  response.end(JSON.stringify(payload));
}

module.exports = async function handler(request, response) {
  if (request.method && request.method !== "GET") {
    response.statusCode = 405;
    response.setHeader("Allow", "GET");
    response.end("Method Not Allowed");
    return;
  }

  const csvUrl = process.env.LIVE_SHEET_CSV_URL;

  if (!csvUrl) {
    sendJson(response, {
      schemaVersion: 1,
      source: "fallback",
      events: publicEvents(JSON.parse(JSON.stringify(fallbackData)).events),
    }, "public, s-maxage=300");
    return;
  }

  try {
    const sheetResponse = await fetch(csvUrl);
    if (!sheetResponse.ok) throw new Error("Sheet request failed: " + sheetResponse.status);

    const csv = await sheetResponse.text();
    const rows = parseCsv(csv);
    const headers = rows[0].map(normalizeHeader);
    const events = rows
      .slice(1)
      .map((row, index) => toEvent(row, headers, index + 1))
      .filter((event) => event.published === true);

    sendJson(response, { schemaVersion: 1, source: "google-sheet", events });
  } catch (error) {
    sendJson(response, {
      schemaVersion: 1,
      source: "fallback",
      warning: "google-sheet-unavailable",
      events: publicEvents(JSON.parse(JSON.stringify(fallbackData)).events),
    }, "public, s-maxage=60");
  }
};
