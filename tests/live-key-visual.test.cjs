"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  enrichLiveEvent,
  enrichLiveEvents,
  findPreviousEvent,
  makeEventId,
  sameSourceUrl,
} = require("../lib/live-key-visual.js");

const baseEvent = {
  id: "builder-id-1",
  date: "2026-09-06",
  venue: "ZEAL THEATER TOKYO",
  title: "Euphoria",
  tweetUrl: "https://x.com/xiao/status/100",
  keyVisualUrl: "",
};

const announcement = {
  text: "元の告知本文",
  imageUrl: "https://pbs.twimg.com/media/announcement.jpg",
  url: "https://x.com/xiao/status/100",
  imageWidth: 1200,
  imageHeight: 800,
};

test("H列が空なら告知ツイートだけを保持する", async () => {
  const event = await enrichLiveEvent(baseEvent, [], async () => announcement);
  assert.deepEqual(event.tweetEmbed, announcement);
  assert.equal(event.keyVisual, undefined);
});

test("pbs.twimg.comの直URLは通信せずキービジュアルになる", async () => {
  let calls = 0;
  const imageUrl = "https://pbs.twimg.com/media/key-visual.jpg?name=orig";
  const event = await enrichLiveEvent(
    { ...baseEvent, tweetUrl: "", keyVisualUrl: imageUrl },
    [],
    async () => { calls += 1; return null; }
  );
  assert.equal(calls, 0);
  assert.deepEqual(event.keyVisual, { sourceUrl: imageUrl, imageUrl });
});

test("後発Xポストの画像だけを追加し告知本文・リンクは変えない", async () => {
  const keyVisualPost = "https://x.com/xiao/status/200?s=20";
  const keyVisualEmbed = {
    text: "後発ポスト本文",
    imageUrl: "https://pbs.twimg.com/media/key-visual.jpg",
    url: "https://x.com/xiao/status/200",
    imageWidth: 900,
    imageHeight: 1200,
  };
  const event = await enrichLiveEvent(
    { ...baseEvent, keyVisualUrl: keyVisualPost },
    [],
    async (url) => sameSourceUrl(url, baseEvent.tweetUrl) ? announcement : keyVisualEmbed
  );
  assert.equal(event.tweetEmbed.text, "元の告知本文");
  assert.equal(event.tweetEmbed.url, "https://x.com/xiao/status/100");
  assert.equal(event.keyVisual.imageUrl, keyVisualEmbed.imageUrl);
  assert.equal(event.keyVisual.sourceUrl, keyVisualPost);
});

test("同一公演・同一投稿なら取得失敗時に前回キービジュアルを保持する", async () => {
  const sourceUrl = "https://x.com/xiao/status/200";
  const previousKeyVisual = {
    sourceUrl,
    imageUrl: "https://pbs.twimg.com/media/previous.jpg",
  };
  const previous = [{ ...baseEvent, id: "api-id-99", keyVisualUrl: sourceUrl, keyVisual: previousKeyVisual }];
  const event = await enrichLiveEvent(
    { ...baseEvent, tweetUrl: "", keyVisualUrl: sourceUrl },
    previous,
    async () => null
  );
  assert.deepEqual(event.keyVisual, previousKeyVisual);
});

test("別投稿へ変更した場合は古いキービジュアルを再利用しない", async () => {
  const previous = [{
    ...baseEvent,
    keyVisual: {
      sourceUrl: "https://x.com/xiao/status/200",
      imageUrl: "https://pbs.twimg.com/media/previous.jpg",
    },
  }];
  const event = await enrichLiveEvent(
    { ...baseEvent, tweetUrl: "", keyVisualUrl: "https://x.com/xiao/status/201" },
    previous,
    async () => null
  );
  assert.equal(event.keyVisual, undefined);
});

test("builder/APIでID形式が違っても一意な公演情報で前回値を見つける", () => {
  const previous = [{ ...baseEvent, id: "api-id-99" }];
  assert.equal(findPreviousEvent(previous, baseEvent), previous[0]);
});

test("builderとAPIは同じ行から同じIDを生成し、重複公演でも前回値を特定できる", () => {
  const id = makeEventId(baseEvent.date, baseEvent.venue, baseEvent.title, 1, 7);
  const current = { ...baseEvent, id };
  const previous = [
    { ...baseEvent, id, keyVisual: { sourceUrl: "https://x.com/xiao/status/200", imageUrl: "https://pbs.twimg.com/media/right.jpg" } },
    { ...baseEvent, id: makeEventId(baseEvent.date, baseEvent.venue, baseEvent.title, 1, 8) },
  ];
  assert.equal(findPreviousEvent(previous, current), previous[0]);
});

test("同一X投稿は複数行・複数列にあっても1回だけ取得する", async () => {
  let calls = 0;
  const events = Array.from({ length: 8 }, (_, index) => ({
    ...baseEvent,
    id: `event-${index}`,
    tweetUrl: "https://x.com/xiao/status/100",
    keyVisualUrl: "https://x.com/xiao/status/100",
  }));
  await enrichLiveEvents(events, [], async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return announcement;
  }, { concurrency: 4 });
  assert.equal(calls, 1);
});

test("外部取得は指定した同時公演数を超えない", async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const events = Array.from({ length: 8 }, (_, index) => ({
    ...baseEvent,
    id: `unique-event-${index}`,
    tweetUrl: "",
    keyVisualUrl: `https://x.com/xiao/status/${300 + index}`,
  }));
  await enrichLiveEvents(events, [], async (url) => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { ...announcement, url, imageUrl: `https://pbs.twimg.com/media/${calls}.jpg` };
  }, { concurrency: 4 });
  assert.equal(calls, 8);
  assert.ok(maxActive <= 4);
});

test("公開イベント数が安全上限を超えたら処理を中断する", async () => {
  await assert.rejects(
    enrichLiveEvents([baseEvent, baseEvent], [], async () => announcement, { maxEvents: 1 }),
    /上限1件/
  );
});

test("API経路もH列を読み、告知本文を保ったまま画像を上書きする", async () => {
  const originalFetch = global.fetch;
  const csv = [
    "公開,日付,タイトル,会場,詳細,告知ツイートURL,備考,キービジュアルURL(任意)",
    "TRUE,2026-09-06,Euphoria,ZEAL THEATER TOKYO,2部制,https://x.com/xiao/status/100,,https://pbs.twimg.com/media/api-key-visual.jpg",
  ].join("\n");

  global.fetch = async (url) => {
    if (url === "https://example.test/live.csv") {
      return { ok: true, text: async () => csv };
    }
    return { ok: true, json: async () => ({ tweet: {
      text: announcement.text,
      url: announcement.url,
      media: { photos: [{ url: announcement.imageUrl, width: 1200, height: 800 }] },
    } }) };
  };

  const handler = require("../api/live.js");
  const response = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };

  try {
    process.env.LIVE_SHEET_CSV_URL = "https://example.test/live.csv";
    await handler({ method: "GET" }, response);
    const payload = JSON.parse(response.body);
    assert.equal(payload.events[0].tweetEmbed.text, announcement.text);
    assert.equal(payload.events[0].tweetEmbed.url, announcement.url);
    assert.equal(payload.events[0].keyVisual.imageUrl, "https://pbs.twimg.com/media/api-key-visual.jpg");
  } finally {
    delete process.env.LIVE_SHEET_CSV_URL;
    global.fetch = originalFetch;
  }
});

test("API経路は8件を超えたら既存JSONへフォールバックする", async () => {
  const originalFetch = global.fetch;
  const header = "公開,日付,タイトル,会場,詳細,告知ツイートURL,備考,キービジュアルURL(任意)";
  const csv = [header].concat(Array.from({ length: 9 }, (_, index) =>
    `TRUE,2026-09-${String(index + 1).padStart(2, "0")},公演${index},会場${index},,,,,`
  )).join("\n");
  global.fetch = async () => ({ ok: true, text: async () => csv });

  const handler = require("../api/live.js");
  const response = {
    setHeader() {},
    end(body) { this.body = body; },
  };
  try {
    process.env.LIVE_SHEET_CSV_URL = "https://example.test/too-many.csv";
    await handler({ method: "GET" }, response);
    const payload = JSON.parse(response.body);
    assert.equal(payload.source, "fallback");
    assert.equal(payload.warning, "google-sheet-unavailable");
  } finally {
    delete process.env.LIVE_SHEET_CSV_URL;
    global.fetch = originalFetch;
  }
});

test("定期builder経路もH列からkeyVisualを生成する", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xiao-live-key-visual-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tempRoot, "scripts"));
  fs.mkdirSync(path.join(tempRoot, "lib"));
  fs.mkdirSync(path.join(tempRoot, "data"));
  fs.copyFileSync(path.join(__dirname, "..", "scripts", "build-live-events.mjs"), path.join(tempRoot, "scripts", "build-live-events.mjs"));
  fs.copyFileSync(path.join(__dirname, "..", "lib", "live-key-visual.js"), path.join(tempRoot, "lib", "live-key-visual.js"));
  fs.writeFileSync(path.join(tempRoot, "data", "live-events.json"), '{"schemaVersion":1,"events":[]}\n');

  const imageUrl = "https://pbs.twimg.com/media/builder-key-visual.jpg";
  const csv = [
    "公開,日付,タイトル,会場,詳細,告知ツイートURL,備考,キービジュアルURL(任意)",
    `TRUE,2026-09-06,Euphoria,ZEAL THEATER TOKYO,2部制,,,${imageUrl}`,
  ].join("\n");
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
    response.end(csv);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(tempRoot, "scripts", "build-live-events.mjs")], {
      env: { ...process.env, SHEET_CSV_URL: `http://127.0.0.1:${address.port}/live.csv` },
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0);

  const payload = JSON.parse(fs.readFileSync(path.join(tempRoot, "data", "live-events.json"), "utf8"));
  assert.equal(payload.events[0].keyVisual.imageUrl, imageUrl);
});
