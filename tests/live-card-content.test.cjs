const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.childNodes = [];
    this.className = '';
    this.textContent = '';
    this.listeners = {};
    this.classList = {
      add: (name) => this.classList.toggle(name, true),
      toggle: (name, enabled) => {
        const classes = new Set(this.className.split(' ').filter(Boolean));
        if (enabled) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(' ');
      },
    };
  }
  appendChild(node) { this.childNodes.push(node); node.parentNode = this; return node; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  remove() { this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this); }
}
const filename = process.env.LIVE_CARD_SOURCE || path.join(__dirname, '..', 'live.js');
const source = fs.readFileSync(filename, 'utf8').replace(/\}\)\(\);\s*$/, 'globalThis.createItem = createItem; })();');
const context = {
  document: { createElement: (tag) => new Element(tag), querySelector: () => null },
};
vm.runInNewContext(source, context);
const walk = (node) => [node, ...node.childNodes.flatMap(walk)];
const nodes = (card, cls) => walk(card).filter((node) => node.className.split(' ').includes(cls));
const texts = (card) => walk(card).map((node) => node.textContent).filter(Boolean);
const links = (card) => walk(card).filter((node) => node.tagName === 'a');
const event = {
  date: '2030-11-29', weekday: 'Fri', title: 'Euphoria', venue: '文京HEAD POWER',
  detail: '1部 OPEN 11:30 / START 12:00\n2部 OPEN 17:00 / START 17:30',
  note: 'A席抽選受付 19:00〜22:00', tweetUrl: 'https://x.com/Euphoria__live/status/2108482601031798789',
  tweetEmbed: { text: 'Euphoria告知全文：文京HEAD POWER 11:30 チケット発売', url: 'https://x.com/Euphoria__live/status/2108482601031798789', imageUrl: 'https://pbs.twimg.com/media/announcement.jpg', imageWidth: 2000, imageHeight: 1400 },
};

test('会場・詳細・備考は画像側に一度、告知全文と重複リンクは出さない', () => {
  const card = context.createItem(event, false, true);
  for (const value of [event.venue, event.detail, event.note]) assert.equal(texts(card).filter((text) => text === value).length, 1);
  assert.equal(texts(card).includes(event.tweetEmbed.text), false);
  assert.equal(links(card).length, 1);
  assert.equal(links(card)[0].href, event.tweetUrl);
  assert.equal(nodes(card, 'live-meta').length, 0);
  assert.equal(nodes(card, 'live-embed--wide').length, 1);
  assert.equal(nodes(card, 'live-embed__img').length, 1);
});

test('後発キービジュアルでもリンクは元告知、失敗時は元画像へ一度だけfallback', () => {
  const card = context.createItem({ ...event, keyVisual: { imageUrl: 'https://pbs.twimg.com/media/visual.jpg', imageWidth: 1400, imageHeight: 2000 } }, false, true);
  const image = nodes(card, 'live-embed__img')[0];
  assert.equal(image.src, 'https://pbs.twimg.com/media/visual.jpg');
  assert.equal(nodes(card, 'live-embed--wide').length, 0);
  assert.equal(links(card)[0].href, event.tweetUrl);
  image.listeners.error();
  assert.equal(image.src, event.tweetEmbed.imageUrl);
  assert.equal(nodes(card, 'live-embed--wide').length, 1);
  image.listeners.error();
  assert.equal(nodes(card, 'live-embed__img').length, 0);
  assert.equal(texts(card).includes(event.detail), true);
  assert.equal(links(card).length, 1);
});

test('詳細が空のときだけ告知本文を補助表示する', () => {
  const card = context.createItem({ ...event, detail: '' }, false, true);
  assert.equal(texts(card).filter((text) => text === event.tweetEmbed.text).length, 1);
  assert.equal(links(card).length, 1);
});

test('画像なし・埋め込みOFF・Archiveの情報と告知導線は保持する', () => {
  for (const [data, past, embed] of [[{ ...event, tweetEmbed: null }, false, true], [{ ...event, tweetEmbed: { ...event.tweetEmbed, imageUrl: '' } }, false, true], [event, false, false], [event, true, true]]) {
    const card = context.createItem(data, past, embed);
    assert.equal(nodes(card, 'live-embed').length, 0);
    assert.equal(nodes(card, 'live-meta')[0].textContent, `${event.venue} / ${event.detail}`);
    assert.equal(texts(card).filter((text) => text === event.note).length, 1);
    assert.equal(links(card).length, 1);
  }
});

test('画像もシート詳細もない場合、通常の概要に告知本文を補う', () => {
  const card = context.createItem({ ...event, detail: '', tweetEmbed: { ...event.tweetEmbed, imageUrl: '' } }, false, true);
  assert.equal(nodes(card, 'live-embed').length, 0);
  assert.equal(nodes(card, 'live-meta')[0].textContent, `${event.venue} / ${event.tweetEmbed.text}`);
  assert.equal(links(card).length, 1);
});

test('画像だけでもシート詳細と元告知リンクを保持する', () => {
  const card = context.createItem({ ...event, tweetEmbed: null, keyVisual: { imageUrl: 'https://pbs.twimg.com/media/visual.jpg' } }, false, true);
  assert.equal(nodes(card, 'live-embed__img').length, 1);
  assert.equal(texts(card).includes(event.detail), true);
  assert.equal(links(card)[0].href, event.tweetUrl);
});

test('空のtweetEmbedでは枠を追加せず、未定の通常表示を保持する', () => {
  const card = context.createItem({ date: '2030-02-07', title: '未定', venue: '都内某所', detail: '両部', tweetEmbed: {} }, false, true);
  assert.equal(nodes(card, 'live-embed').length, 0);
  assert.equal(nodes(card, 'live-meta')[0].textContent, '都内某所 / 両部');
  assert.equal(links(card).length, 0);
});

test('元告知URLがない場合は取得済み告知リンクを一つ使う', () => {
  const card = context.createItem({ ...event, tweetUrl: '' }, false, true);
  assert.equal(links(card).length, 1);
  assert.equal(links(card)[0].href, event.tweetEmbed.url);
});

test('Ticketの既存導線を保持し、告知導線は一つにする', () => {
  const card = context.createItem({ ...event, ticketUrl: 'https://tiget.net/events/123' }, false, true);
  assert.equal(links(card).length, 2);
  assert.equal(links(card)[0].href, 'https://tiget.net/events/123');
  assert.equal(links(card)[1].href, event.tweetUrl);
});

test('シート本文をHTMLとして解釈せず文字として表示する', () => {
  const detail = '<img src=x onerror=alert(1)>';
  const card = context.createItem({ ...event, detail }, false, true);
  assert.equal(texts(card).includes(detail), true);
  assert.equal(walk(card).filter((node) => node.tagName === 'img').length, 1);
});
