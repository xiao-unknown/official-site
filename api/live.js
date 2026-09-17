/* =========================================================
   /api/live — Apps Script公開Feedまたは旧CSVを検証してJSONで返す
   入力元が未設定・競合・取得失敗・契約違反のときは
   data/live-events.json をフォールバックとして返す。
   公開行だけを採用し、取得時間・body・件数・文字列長・補完並列数を制限する。
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

// 公開判定用headerが正規化後に1件だけあることを確認する
function hasPublishedColumn(headers) {
  const publishedHeaders = new Set(["published", "公開", "表示"].map(normalizeHeader));
  return headers.filter((header) => publishedHeaders.has(header)).length === 1;
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

function toEvent(row, headers, index, usePublishedColumn) {
  const date = normalizeDate(getCell(row, headers, ["date", "日付"]));
  const venue = getCell(row, headers, ["venue", "会場"]);
  const title = getCell(row, headers, ["title", "タイトル"]);

  return {
    id: getCell(row, headers, ["id", "ID"]) || [date, venue, title, index].filter(Boolean).join("-"),
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
}

/* ---------- 告知ツイートからフライヤー画像と本文を取得する ---------- */

const FX_HOST = "https://api.fxtwitter.com";
const TWEET_URL_RE =
  /^https:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:[/?#].*)?$/i;
const IMAGE_HOST_PREFIX = "https://pbs.twimg.com/";
const FETCH_TIMEOUT_MS = 6000;
const MAX_REMOTE_BODY_BYTES = 512 * 1024;
const MAX_FEED_EVENTS = 1000;
const MAX_FEED_STRING_LENGTH = 8192;
const MAX_TWEET_ENRICH_CONCURRENCY = 4;
const MAX_TWEET_ENRICH_EVENTS = 4;

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

function assertedContentLength(response) {
  if (
    !response ||
    !response.headers ||
    typeof response.headers.get !== "function"
  ) {
    return null;
  }

  const raw = response.headers.get("content-length");
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function readLimitedResponseText(response) {
  const contentLength = assertedContentLength(response);
  if (contentLength !== null && contentLength > MAX_REMOTE_BODY_BYTES) {
    throw new Error("Remote response body is too large");
  }

  if (
    response &&
    response.body &&
    typeof response.body.getReader === "function"
  ) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) {
          throw new Error("Remote response body chunk is invalid");
        }
        totalBytes += chunk.value.byteLength;
        if (totalBytes > MAX_REMOTE_BODY_BYTES) {
          try {
            await reader.cancel();
          } catch (error) {
            // The size violation is the authoritative failure.
          }
          throw new Error("Remote response body is too large");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } finally {
      if (typeof reader.releaseLock === "function") reader.releaseLock();
    }
  }

  if (!response || typeof response.text !== "function") {
    throw new Error("Remote response text reader is unavailable");
  }
  const text = await response.text();
  if (utf8ByteLength(text) > MAX_REMOTE_BODY_BYTES) {
    throw new Error("Remote response body is too large");
  }
  return text;
}

async function readLimitedResponseJson(response) {
  if (
    (response &&
      response.body &&
      typeof response.body.getReader === "function") ||
    (response && typeof response.text === "function")
  ) {
    return JSON.parse(await readLimitedResponseText(response));
  }

  if (!response || typeof response.json !== "function") {
    throw new Error("Remote response JSON reader is unavailable");
  }
  const payload = await response.json();
  if (utf8ByteLength(JSON.stringify(payload)) > MAX_REMOTE_BODY_BYTES) {
    throw new Error("Remote response body is too large");
  }
  return payload;
}

async function fetchWithTimeout(url, options, consumeResponse) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...(options || {}),
      signal: controller.signal,
    });
    return consumeResponse
      ? await consumeResponse(response)
      : response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTweetEmbed(tweetUrl) {
  const match = TWEET_URL_RE.exec(String(tweetUrl || "").trim());
  if (!match) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${FX_HOST}/${match[1]}/status/${match[2]}`, { signal: controller.signal });
    if (!res.ok) return null;

    const data = await readLimitedResponseJson(res);
    const tweet = data && data.tweet;
    if (!tweet) return null;

    const photo = tweet.media && Array.isArray(tweet.media.photos) ? tweet.media.photos[0] : null;
    const imageUrl = photo && typeof photo.url === "string" && photo.url.startsWith(IMAGE_HOST_PREFIX) ? photo.url : "";

    const enrichedUrl = String(tweet.url || "").trim();
    const embed = {
      text: String(tweet.text || ""),
      imageUrl,
      url: enrichedUrl && isValidTweetUrl(enrichedUrl) ? enrichedUrl : tweetUrl,
    };
    if (imageUrl && Number.isFinite(photo.width) && Number.isFinite(photo.height)) {
      embed.imageWidth = photo.width;
      embed.imageHeight = photo.height;
    }
    return embed;
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function enrichEvents(events) {
  const results = new Array(events.length);
  let nextIndex = 0;
  let remainingEnrichmentSlots = MAX_TWEET_ENRICH_EVENTS;
  const workers = Array.from(
    { length: Math.min(MAX_TWEET_ENRICH_CONCURRENCY, events.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= events.length) return;
        const event = events[index];
        if (!event.tweetUrl || event.tweetEmbed) {
          results[index] = event;
          continue;
        }
        if (remainingEnrichmentSlots <= 0) {
          results[index] = event;
          continue;
        }
        remainingEnrichmentSlots -= 1;
        const tweetEmbed = await fetchTweetEmbed(event.tweetUrl);
        results[index] = tweetEmbed ? { ...event, tweetEmbed } : event;
      }
    }
  );
  await Promise.all(workers);
  return results;
}

const ALLOWED_FEED_EVENT_FIELDS = new Set([
  "id",
  "published",
  "date",
  "title",
  "venue",
  "detail",
  "tweetUrl",
  "note",
]);

function hasOnlyAllowedFeedEventFields(events) {
  return (
    Array.isArray(events) &&
    events.every(
      (event) =>
        event !== null &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        Object.keys(event).every((field) => ALLOWED_FEED_EVENT_FIELDS.has(field))
    )
  );
}

function isValidFeedDate(value) {
  const match =
    typeof value === "string" &&
    value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(0);
  calendarDate.setUTCHours(0, 0, 0, 0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  return (
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day
  );
}

function isValidTweetUrl(value) {
  if (value === "") return true;
  if (typeof value !== "string") return false;
  return TWEET_URL_RE.test(value.trim());
}

function hasValidFeedEventFieldTypes(event) {
  return Object.entries(event).every(([field, value]) =>
    field === "published"
      ? value === true
      : typeof value === "string" && value.length <= MAX_FEED_STRING_LENGTH
  );
}

function hasValidAppsScriptFeedEvents(events) {
  return (
    hasOnlyAllowedFeedEventFields(events) &&
    events.length <= MAX_FEED_EVENTS &&
    events.every(
      (event) =>
        event.published === true &&
        hasValidFeedEventFieldTypes(event) &&
        isValidFeedDate(event.date) &&
        (!Object.prototype.hasOwnProperty.call(event, "tweetUrl") ||
          isValidTweetUrl(event.tweetUrl))
    )
  );
}

function hasValidLegacyEvents(events) {
  return (
    Array.isArray(events) &&
    events.length <= MAX_FEED_EVENTS &&
    events.every(
      (event) =>
        hasValidFeedEventFieldTypes(event) &&
        isValidFeedDate(event.date) &&
        isValidTweetUrl(event.tweetUrl)
    )
  );
}

const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isValidAppsScriptFeedEnvelope(feed) {
  return (
    feed !== null &&
    typeof feed === "object" &&
    !Array.isArray(feed) &&
    feed.schemaVersion === 1 &&
    feed.ok === true &&
    typeof feed.generatedAt === "string" &&
    RFC3339_RE.test(feed.generatedAt) &&
    Number.isFinite(Date.parse(feed.generatedAt)) &&
    hasValidAppsScriptFeedEvents(feed.events)
  );
}

function buildCompatibleEventId(date, venue, title, index) {
  const suffix = `-${index}`;
  const base = [date, venue, title].filter(Boolean).join("-");
  const maxBaseLength = Math.max(0, MAX_FEED_STRING_LENGTH - suffix.length);
  return `${base.slice(0, maxBaseLength)}${suffix}`;
}

function toCompatibleAppsScriptEvent(event, index) {
  const date = event.date;
  const venue = event.venue || "";
  const title = event.title || "";
  return {
    id: event.id || buildCompatibleEventId(date, venue, title, index),
    published: true,
    date,
    weekday: resolveWeekday("", date),
    venue,
    title,
    detail: event.detail || "",
    ticketUrl: "",
    tweetUrl: event.tweetUrl || "",
    note: event.note || "",
  };
}

function publicEvents(events) {
  return Array.isArray(events) ? events.filter((event) => event.published === true) : [];
}

function sendJson(response, payload, cacheControl) {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", cacheControl || "public, s-maxage=60, stale-while-revalidate=240");
  response.end(JSON.stringify(payload));
}

module.exports = async function handler(request, response) {
  if (request.method && request.method !== "GET") {
    response.statusCode = 405;
    response.setHeader("Allow", "GET");
    response.end("Method Not Allowed");
    return;
  }

  const feedUrl = process.env.LIVE_FEED_URL;
  const csvUrl = process.env.LIVE_SHEET_CSV_URL;

  if (feedUrl && csvUrl) {
    sendJson(response, {
      schemaVersion: 1,
      source: "fallback",
      warning: "live-source-config-invalid",
      events: publicEvents(JSON.parse(JSON.stringify(fallbackData)).events),
    }, "public, s-maxage=60");
    return;
  }

  if (!feedUrl && !csvUrl) {
    sendJson(response, {
      schemaVersion: 1,
      source: "fallback",
      warning: "live-source-not-configured",
      events: publicEvents(JSON.parse(JSON.stringify(fallbackData)).events),
    }, "public, s-maxage=300");
    return;
  }

  try {
    if (feedUrl) {
      const feed = await fetchWithTimeout(feedUrl, null, async (feedResponse) => {
        if (!feedResponse.ok) {
          throw new Error("Feed request failed: " + feedResponse.status);
        }
        return readLimitedResponseJson(feedResponse);
      });
      if (!isValidAppsScriptFeedEnvelope(feed)) {
        throw new Error("Feed contract is invalid");
      }
      const events = feed.events.map((event, index) =>
        toCompatibleAppsScriptEvent(event, index + 1)
      );
      if (!hasValidLegacyEvents(events)) {
        throw new Error("Normalized Feed contract is invalid");
      }

      sendJson(response, {
        schemaVersion: 1,
        source: "google-sheet",
        events: await enrichEvents(events),
      });
      return;
    }

    const csv = await fetchWithTimeout(csvUrl, null, async (sheetResponse) => {
      if (!sheetResponse.ok) {
        throw new Error("Sheet request failed: " + sheetResponse.status);
      }
      return readLimitedResponseText(sheetResponse);
    });
    const rows = parseCsv(csv);
    const headers = rows[0].map(normalizeHeader);
    const usePublishedColumn = hasPublishedColumn(headers);
    if (!usePublishedColumn) {
      throw new Error("Published header is required");
    }

    const events = rows
      .slice(1)
      .map((row, index) => toEvent(row, headers, index + 1, usePublishedColumn))
      .filter((event) => event.published === true && event.date);
    if (!hasValidLegacyEvents(events)) {
      throw new Error("Legacy Feed contract is invalid");
    }

    sendJson(response, { schemaVersion: 1, source: "google-sheet", events: await enrichEvents(events) });
  } catch (error) {
    sendJson(response, {
      schemaVersion: 1,
      source: "fallback",
      warning: "google-sheet-unavailable",
      events: publicEvents(JSON.parse(JSON.stringify(fallbackData)).events),
    }, "public, s-maxage=60");
  }
};
