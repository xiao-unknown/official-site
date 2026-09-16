"use strict";

const TWEET_URL_RE = /^https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i;
const IMAGE_HOST_PREFIX = "https://pbs.twimg.com/";
const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_CONCURRENCY = 4;

function tweetStatusId(value) {
  const match = TWEET_URL_RE.exec(String(value || "").trim());
  return match ? match[2] : "";
}

function isDirectKeyVisualUrl(value) {
  return String(value || "").trim().startsWith(IMAGE_HOST_PREFIX);
}

function makeEventId(date, venue, title, sourceIndex, rowIndex) {
  return [date, venue, title, `${sourceIndex}-${rowIndex}`].filter(Boolean).join("-");
}

function eventSignature(event) {
  return [event && event.date, event && event.venue, event && event.title]
    .map((value) => String(value || "").trim())
    .join("\u0000");
}

function findPreviousEvent(previousEvents, event) {
  if (!Array.isArray(previousEvents)) return null;

  const exact = previousEvents.find((candidate) => candidate && candidate.id === event.id);
  if (exact) return exact;

  const signature = eventSignature(event);
  if (!signature.replace(/\u0000/g, "")) return null;
  const matches = previousEvents.filter((candidate) => eventSignature(candidate) === signature);
  return matches.length === 1 ? matches[0] : null;
}

function sameSourceUrl(left, right) {
  const leftStatusId = tweetStatusId(left);
  const rightStatusId = tweetStatusId(right);
  if (leftStatusId || rightStatusId) return Boolean(leftStatusId) && leftStatusId === rightStatusId;
  return String(left || "").trim() === String(right || "").trim();
}

function toKeyVisual(sourceUrl, embed) {
  if (!embed || !embed.imageUrl) return null;
  const keyVisual = {
    sourceUrl: String(sourceUrl || "").trim(),
    imageUrl: embed.imageUrl,
  };
  if (embed.url) keyVisual.url = embed.url;
  if (Number.isFinite(embed.imageWidth) && Number.isFinite(embed.imageHeight)) {
    keyVisual.imageWidth = embed.imageWidth;
    keyVisual.imageHeight = embed.imageHeight;
  }
  return keyVisual;
}

async function resolveTweetEmbed(event, previousEvent, fetchTweetEmbed) {
  if (!event.tweetUrl) return null;

  const fetched = await fetchTweetEmbed(event.tweetUrl);
  if (fetched) return fetched;

  const previous = previousEvent && previousEvent.tweetEmbed;
  if (!previous) return null;
  const previousUrl = previous.url || previousEvent.tweetUrl;
  return sameSourceUrl(previousUrl, event.tweetUrl) ? previous : null;
}

async function resolveKeyVisual(event, previousEvent, fetchTweetEmbed) {
  const sourceUrl = String(event.keyVisualUrl || "").trim();
  if (!sourceUrl) return null;

  if (isDirectKeyVisualUrl(sourceUrl)) {
    return { sourceUrl, imageUrl: sourceUrl };
  }

  const fetched = await fetchTweetEmbed(sourceUrl);
  const resolved = toKeyVisual(sourceUrl, fetched);
  if (resolved) return resolved;

  const previous = previousEvent && previousEvent.keyVisual;
  if (!previous || !previous.imageUrl || !previous.sourceUrl) return null;
  return sameSourceUrl(previous.sourceUrl, sourceUrl) ? previous : null;
}

async function enrichLiveEvent(event, previousEvents, fetchTweetEmbed) {
  const previousEvent = findPreviousEvent(previousEvents, event);
  const [tweetEmbed, keyVisual] = await Promise.all([
    resolveTweetEmbed(event, previousEvent, fetchTweetEmbed),
    resolveKeyVisual(event, previousEvent, fetchTweetEmbed),
  ]);

  const enriched = { ...event };
  if (tweetEmbed) enriched.tweetEmbed = tweetEmbed;
  if (keyVisual) enriched.keyVisual = keyVisual;
  return enriched;
}

function memoizeTweetFetcher(fetchTweetEmbed) {
  const requests = new Map();
  return (url) => {
    const raw = String(url || "").trim();
    const statusId = tweetStatusId(raw);
    const key = statusId ? `status:${statusId}` : `url:${raw}`;
    if (!requests.has(key)) requests.set(key, Promise.resolve(fetchTweetEmbed(raw)));
    return requests.get(key);
  };
}

async function enrichLiveEvents(events, previousEvents, fetchTweetEmbed, options = {}) {
  if (!Array.isArray(events)) return [];
  const maxEvents = Number.isInteger(options.maxEvents) ? options.maxEvents : DEFAULT_MAX_EVENTS;
  if (events.length > maxEvents) {
    throw new RangeError(`公開ライブ情報が上限${maxEvents}件を超えています: ${events.length}件`);
  }

  const requestedConcurrency = Number.isInteger(options.concurrency) ? options.concurrency : DEFAULT_CONCURRENCY;
  const concurrency = Math.max(1, Math.min(requestedConcurrency, events.length || 1));
  const fetchOnce = memoizeTweetFetcher(fetchTweetEmbed);
  const enriched = new Array(events.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < events.length) {
      const index = nextIndex;
      nextIndex += 1;
      enriched[index] = await enrichLiveEvent(events[index], previousEvents, fetchOnce);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return enriched;
}

module.exports = {
  enrichLiveEvent,
  enrichLiveEvents,
  findPreviousEvent,
  isDirectKeyVisualUrl,
  makeEventId,
  sameSourceUrl,
  tweetStatusId,
};
