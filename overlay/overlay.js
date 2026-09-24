// Renders chat events from the Twitch and YouTube sources into the bar or list.
// Chat text is only inserted with textContent, so it cannot inject markup; keep
// it that way when changing the row builders below.

const container = document.getElementById('chat');
const CONFIG = window.CHAT_CONFIG ?? {};

let baseAppearance = {};   // config as written, including the per-layout blocks
let appearance = {};       // the settings in force for the current layout
let emotes = null;         // the third-party emote index, once it is built

const PLATFORM_ICONS = {
  twitch: {
    color: '#9146FF',
    path: 'M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z'
  },
  youtube: {
    color: '#FF0000',
    path: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z'
  }
};

// --------------------------------------------------------------------- layout

// The bar scrolls sideways; the list stacks messages, newest at the bottom.
// "auto" takes the bar only for sources at least twice as wide as they are tall.
const BAR_MIN_ASPECT = 2;
let currentLayout = 'bar';

function layoutFor() {
  const wanted = baseAppearance.layout ?? 'auto';
  if (wanted === 'bar' || wanted === 'list') return wanted;
  return window.innerHeight > 0 && window.innerWidth >= window.innerHeight * BAR_MIN_ASPECT ? 'bar' : 'list';
}

// appearance.bar and appearance.list hold settings for one layout, so a single
// config can serve a bar in one scene and a list in another. They override the
// shared settings while that layout is active; objects are merged key by key.
function appearanceFor(layout) {
  const { bar, list, ...shared } = baseAppearance;
  const override = (layout === 'list' ? list : bar) ?? {};
  const merged = { ...shared, ...override };

  for (const [key, value] of Object.entries(override)) {
    const base = shared[key];
    const mergeable = (v) => v && typeof v === 'object' && !Array.isArray(v);
    if (mergeable(base) && mergeable(value)) merged[key] = { ...base, ...value };
  }
  return merged;
}

// The edge new messages enter from; older ones leave at the opposite one.
function newestSide() {
  const wanted = appearance.newestAt ?? 'auto';
  if (currentLayout === 'list') return wanted === 'top' ? 'top' : 'bottom';
  return wanted === 'left' ? 'left' : 'right';
}

// CSS selects the layout and direction from these attributes.
function applyLayout() {
  const previous = currentLayout;
  currentLayout = layoutFor();
  appearance = appearanceFor(currentLayout);
  applyAppearanceVars();
  document.documentElement.dataset.layout = currentLayout;
  document.documentElement.dataset.newest = newestSide();
  // Rows that dropped their name in the bar get it back in the list.
  if (previous !== currentLayout && currentLayout === 'list') {
    for (const row of container.querySelectorAll('.message-row[data-continuation]')) {
      redrawUserBox(row, false);
      delete row.dataset.continuation;
    }
  }
}

// ------------------------------------------------------------------ appearance

// "auto" fits the text to the browser source: in the bar its height / 1.75,
// which leaves room for emotes at 1.3 times the font size; in the list its
// width / 20, about what a chat panel of that width usually runs. Pages too
// tall for a bar, such as a regular browser window or a full-canvas source
// cropped in OBS, get 24px instead of giant text.
const AUTO_SIZE_MAX_HEIGHT = 200;
const AUTO_LIST_DIVISOR = 20;
const AUTO_LIST_MIN = 14;
const AUTO_LIST_MAX = 32;

function fontSizeFor(font) {
  const size = font.size ?? 'auto';
  if (size !== 'auto') {
    const px = parseFloat(size);   // 28, "28" and "28px" alike
    return px > 0 ? px : 24;
  }
  if (currentLayout === 'list') {
    const width = window.innerWidth;
    return width > 0 ? Math.min(Math.max(Math.round(width / AUTO_LIST_DIVISOR), AUTO_LIST_MIN), AUTO_LIST_MAX) : 24;
  }
  const height = window.innerHeight;
  return height > 0 && height <= AUTO_SIZE_MAX_HEIGHT ? Math.max(Math.round(height / 1.75), 1) : 24;
}

function applyFontSize() {
  const size = fontSizeFor(appearance.font ?? {});
  const root = document.documentElement.style;
  const emote = Math.round(size * EMOTE_HEIGHT_RATIO);
  root.setProperty('--font-size', `${size}px`);
  root.setProperty('--emote-size', `${emote}px`);
  // Rows keep this height whatever they hold, so snapped emotes, which may be a
  // few pixels taller, do not make the spacing uneven.
  root.setProperty('--row-height', `${emote + EMOTE_SNAP_PX}px`);

  updateEmoteTarget();
  emotes?.setTarget(emoteTarget);
  // Messages already on screen keep their file but follow the new size: their
  // own height was set for the old one.
  for (const img of container.querySelectorAll('img.emote')) img.style.height = '';
}

function applyAppearance(a) {
  baseAppearance = a ?? {};
  applyLayout();
}

// Writes the current settings onto :root, where overlay.css reads them. Run
// again after a layout switch, since the layouts can carry different values.
function applyAppearanceVars() {
  const font = appearance.font ?? {};
  const root = document.documentElement.style;

  root.setProperty('--font-family', `'${font.family ?? 'Montserrat'}', sans-serif`);
  applyFontSize();
  root.setProperty('--font-weight', String(font.weight ?? 700));
  root.setProperty('--font-color', appearance.fontColor ?? 'rgba(255,255,255,1)');
  root.setProperty('--text-shadow', appearance.textShadow ?? 'none');
  root.setProperty('--bg-color', appearance.bgColor ?? 'transparent');
  root.setProperty('--highlight-color', appearance.highlightColor ?? 'rgba(164, 0, 255, 0.55)');
  root.setProperty('--pad-right', `${appearance.paddingRight ?? 8}px`);
  // Defaults to paddingRight so both edges match.
  root.setProperty('--fade-left', `${appearance.fadeLeft ?? appearance.paddingRight ?? 8}px`);
  updateWidthCaps();

  const divider = appearance.messageDivider ?? {};
  container.dataset.divider = divider.style ?? 'none';
  root.setProperty('--divider-color', divider.color ?? 'rgba(255,255,255,0.25)');
  root.setProperty('--msg-gap', `${divider.gap ?? 8}px`);
  root.setProperty('--v-align', {
    top: 'flex-start',
    bottom: 'flex-end',
    center: 'center'
  }[appearance.verticalAlign] ?? 'center');
  root.setProperty('--anim-duration', `${appearance.animationDuration ?? 0.5}s`);

  loadFont(font);
}

// Percentages cannot resolve against the shrink-to-fit rows, so % caps are
// converted to pixels against the source width. Rerun on resize.
function updateWidthCaps() {
  const style = getComputedStyle(container);
  const basis = container.clientWidth
    - parseFloat(style.paddingLeft || 0)
    - parseFloat(style.paddingRight || 0);

  // A source in an inactive scene reports no width; keep the last caps until it
  // is shown again.
  if (basis <= 0) return;

  const resolve = (raw, fallback) => {
    const value = String(raw ?? fallback).trim();
    if (!value.endsWith('%')) return value;
    const pct = parseFloat(value);
    if (!Number.isFinite(pct) || basis <= 0) return fallback;
    return `${Math.round((basis * pct) / 100)}px`;
  };

  const root = document.documentElement.style;
  root.setProperty('--max-msg-width', resolve(appearance.longMessages?.maxWidth, '33%'));
  root.setProperty('--max-name-width', resolve(appearance.longMessages?.maxNameWidth, '12em'));
}

// Resizing the source in OBS can also flip between the bar and the list.
window.addEventListener('resize', () => {
  applyLayout();
  trimOverflow();
});

// Scene changes hide and show the source. Anything that needed measuring while
// it was hidden is redone here.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  applyLayout();
  remeasurePending();
  trimOverflow();
});

// Accepts a stylesheet URL, a font file URL or path, or nothing.
let loadedFontUrl = null;
function loadFont(font) {
  const url = font.url;
  if (!url || url === loadedFontUrl) return;
  loadedFontUrl = url;
  const id = 'chat-font-source';
  document.getElementById(id)?.remove();

  if (/\.(woff2?|ttf|otf)(\?|$)/i.test(url)) {
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `@font-face{font-family:'${font.family}';`
      + `src:url('${url}');font-weight:${font.weight ?? 400};font-display:swap;}`;
    document.head.appendChild(style);
  } else {
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = url;
    document.head.appendChild(link);
  }
}

// ---------------------------------------------------------------------- colors

// Stable, readable colour derived from the name, for chatters without one.
function fallbackColor(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `hsl(${Math.abs(h) % 360}, 75%, 65%)`;
}

function nickColorFor(msg) {
  switch (appearance.nickColor) {
    case 'custom': return appearance.customNickColor ?? '#00FF00';
    case 'messagecolor': return null;                       // inherit --font-color
    default: return msg.color || fallbackColor(msg.displayName);
  }
}

// ------------------------------------------------------------------- rendering

function platformIcon(platform) {
  const spec = PLATFORM_ICONS[platform];
  if (!spec) return null;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'platform-icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', spec.path);
  p.setAttribute('fill', spec.color);
  svg.appendChild(p);
  return svg;
}

// Shortens names longer than maxNameChars. Splits by code point so emoji are
// not cut in half.
function shortenName(name) {
  const max = appearance.longMessages?.maxNameChars ?? 15;
  if (!max || max <= 0) return name;
  const chars = [...String(name)];
  if (chars.length <= max) return name;
  return chars.slice(0, max).join('').trimEnd() + '…';
}

// Badge groups, most telling first: maxBadges keeps the ones listed earliest.
const BADGE_KIND_ORDER = ['role', 'subscriber', 'channel', 'account', 'event'];
const DEFAULT_BADGE_KINDS = { role: true, subscriber: true, channel: false, account: false, event: false };

// Emote height, as a share of the font size. Applied as whole pixels: a
// fractional height makes the browser resample the image and look soft.
const EMOTE_HEIGHT_RATIO = 1.3;

// How far an emote file may be from that height and still be used unscaled.
const EMOTE_SNAP_PX = 4;

// The height emotes should end up at. The sources hold on to this object and
// read it per message, so it is updated in place whenever the text size changes.
const emoteTarget = { css: 31, device: 31, dpr: 1, snap: EMOTE_SNAP_PX };

function updateEmoteTarget() {
  const dpr = window.devicePixelRatio || 1;
  const css = Math.round(fontSizeFor(appearance.font ?? {}) * EMOTE_HEIGHT_RATIO);
  Object.assign(emoteTarget, { css, device: Math.round(css * dpr), dpr });
}

function badgeKinds(from = appearance) {
  return { ...DEFAULT_BADGE_KINDS, ...(from.badgeKinds ?? {}) };
}

// True while any badge could appear, so the Twitch API is only used then.
function badgesEnabled(from = appearance) {
  return Boolean(from.showBadges) && Object.values(badgeKinds(from)).some(Boolean);
}

// Either layout can be shown later, so API features are set up when either one
// asks for them; what is drawn still follows the layout in force.
function eitherLayout(wants) {
  return ['bar', 'list'].some((layout) => wants(appearanceFor(layout)));
}

function badgesToShow(msg) {
  if (!badgesEnabled()) return [];
  const kinds = badgeKinds();
  const chosen = (msg.badges ?? [])
    .filter((badge) => kinds[badge.kind ?? 'event'])
    .sort((a, b) => BADGE_KIND_ORDER.indexOf(a.kind ?? 'event') - BADGE_KIND_ORDER.indexOf(b.kind ?? 'event'));

  const max = appearance.maxBadges ?? 2;
  return max > 0 ? chosen.slice(0, max) : chosen;
}

// Each row's message, so a continuation can get its name block back later.
const rowMessages = new WeakMap();

// The name block (icon, avatar, badges, name, separator), or only the
// continuation marker when `repeated`.
function buildUserBox(msg, repeated) {
  const userBox = document.createElement('div');
  userBox.className = 'user-box' + (msg.isAction ? ' action' : '');

  if (!repeated) {
    if (appearance.showPlatformIcon) {
      const icon = platformIcon(msg.platform);
      if (icon) userBox.appendChild(icon);
    }

    const avatarUrl = msg.avatar;
    if (appearance.showAvatar && avatarUrl) {
      const img = document.createElement('img');
      img.className = 'avatar';
      img.src = avatarUrl;
      img.alt = '';
      userBox.appendChild(img);
    }

    for (const badge of badgesToShow(msg)) {
      if (badge.url) {
        const img = document.createElement('img');
        img.className = 'badge';
        img.src = badge.url;
        img.alt = '';
        img.title = badge.title ?? '';
        userBox.appendChild(img);
      } else if (badge.chip) {
        const chip = document.createElement('span');
        chip.className = 'badge-chip';
        chip.style.backgroundColor = badge.color ?? '#888';
        chip.textContent = badge.chip;
        chip.title = badge.title ?? '';
        userBox.appendChild(chip);
      }
    }

    const color = nickColorFor(msg);

    const name = document.createElement('span');
    name.className = 'user-name';
    if (color) name.style.color = color;
    name.textContent = shortenName(msg.displayName);
    userBox.appendChild(name);

    // Separate element, so the name's ellipsis cannot clip it.
    const separator = appearance.separator ?? ':';
    if (separator) {
      const sep = document.createElement('span');
      sep.className = 'name-sep';
      if (color) sep.style.color = color;
      sep.textContent = separator;
      userBox.appendChild(sep);
    }
  } else if (appearance.continuationMarker) {
    const mark = document.createElement('span');
    mark.className = 'continuation';
    const color = nickColorFor(msg);
    if (color) mark.style.color = color;
    mark.textContent = appearance.continuationMarker;
    userBox.appendChild(mark);
  }
  return userBox;
}

function buildRow(msg) {
  const row = document.createElement('div');
  row.className = 'message-row';
  row.dataset.msgid = msg.id;
  row.dataset.sender = msg.userId;
  if (msg.highlight) row.classList.add('highlight');
  rowMessages.set(row, msg);

  // With repeatNickname false, a message from the chatter of the newest row on
  // screen shows continuationMarker instead of the name block. Compared with
  // the rows themselves, since that row may have been deleted or removed
  // meanwhile. The list has room for the name, so it always shows it.
  const senderKey = `${msg.platform}:${msg.userId}`;
  row.dataset.senderKey = senderKey;
  const newest = container.querySelector('.message-row:not([data-leaving])');
  const repeated = currentLayout !== 'list'
    && appearance.repeatNickname === false
    && newest?.dataset.senderKey === senderKey;
  if (repeated) row.dataset.continuation = '1';
  const userBox = buildUserBox(msg, repeated);

  const body = document.createElement('div');
  body.className = 'user-message' + (msg.isAction ? ' action' : '');

  // Inner span, so long text can scroll while the name stays in place.
  const scroller = document.createElement('span');
  scroller.className = 'message-scroll';
  for (const part of msg.parts ?? []) {
    if (part.t === 'emote') {
      const img = document.createElement('img');
      img.className = 'emote';
      img.src = part.v;
      // Set when the file matches the wanted height, so it is not resampled.
      if (part.h) img.style.height = `${part.h}px`;
      img.alt = part.alt ?? '';
      img.title = part.alt ?? '';
      scroller.appendChild(img);
    } else {
      scroller.appendChild(document.createTextNode(part.v));
    }
  }
  body.appendChild(scroller);

  // Omitted when empty, since it would still take up a flex gap.
  if (userBox.childNodes.length) row.appendChild(userBox);
  row.appendChild(body);
  return row;
}

// Text wider than maxWidth scrolls through scrollPasses times, then rests at
// the start with an ellipsis.
function setupLongMessage(row) {
  // The list wraps long messages, so there is nothing to measure there.
  if (currentLayout === 'list') {
    delete row.dataset.remeasure;
    return;
  }

  const body = row.querySelector('.user-message');
  const scroller = body?.querySelector('.message-scroll');
  if (!body || !scroller) return;

  // Nothing can be measured while the source is hidden, and a zero width would
  // make every message look over-long; measure again once it is visible.
  if (body.clientWidth <= 0) {
    row.dataset.remeasure = '1';
    return;
  }
  delete row.dataset.remeasure;

  const overflow = Math.ceil(scroller.scrollWidth - body.clientWidth);
  if (overflow <= 1) return;

  const cfg = appearance.longMessages ?? {};
  const passes = cfg.scrollPasses ?? 2;
  if (passes <= 0) {
    body.classList.add('truncated');
    return;
  }

  // 0.64 is the moving share of the msg-scroll keyframes in overlay.css; change
  // both together. maxPassSeconds caps a pass, so very long text scrolls faster.
  const speed = Math.max(cfg.scrollSpeed ?? 45, 5);
  const maxPass = Math.max(cfg.maxPassSeconds ?? 12, 2);
  const duration = Math.min(Math.max(overflow / speed / 0.64, 3), maxPass);

  scroller.style.setProperty('--scroll-distance', `${overflow}px`);
  scroller.style.animation = `msg-scroll ${duration}s ease-in-out ${passes}`;
  scroller.addEventListener('animationend', () => {
    scroller.style.animation = '';
    scroller.style.removeProperty('--scroll-distance');
    body.classList.add('truncated');
  }, { once: true });
}

// Images have no width until loaded, so wait (with a timeout) before measuring.
function waitForImages(el, timeoutMs = 1500) {
  const pending = [...el.querySelectorAll('img')]
    .filter((img) => !img.complete)
    .map((img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }));
  if (!pending.length) return Promise.resolve();
  return Promise.race([
    Promise.all(pending),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

function removeRow(row) {
  if (!row || row.dataset.leaving) return;
  row.dataset.leaving = '1';
  const out = appearance.animationOut ?? 'fadeOut';
  if (out === 'none') { row.remove(); return; }
  row.classList.add('leaving');
  if (out.startsWith('slide')) row.classList.add('slide');
  if (out.startsWith('bounce')) row.classList.add('bounce');
  const ms = (appearance.animationDuration ?? 0.5) * 1000;
  setTimeout(() => row.remove(), ms + 100);
}

// Replaces a row's name block, e.g. when a deletion frees up the name or the
// layout changes.
function redrawUserBox(row, repeated) {
  const msg = rowMessages.get(row);
  if (!msg) return;
  row.querySelector('.user-box')?.remove();
  const userBox = buildUserBox(msg, repeated);
  if (userBox.childNodes.length) row.prepend(userBox);
}

// Next row towards the newer or older end of the chat, skipping rows that are
// already leaving.
function neighbour(row, direction) {
  let el = row;
  do {
    el = direction === 'newer' ? el.previousElementSibling : el.nextElementSibling;
  } while (el?.dataset.leaving);
  return el;
}

// Removes deleted, purged or expired (hideAfter) rows. A continuation that
// followed a removed row gets its name block back unless the row before it is
// still the same chatter's, so a marker is never left without a name. Rows
// trimmed at the far edge go through removeRow instead: a name appearing there
// would make the overlay jump.
function removeRows(rows) {
  const affected = new Set();
  for (const row of rows) {
    const newer = neighbour(row, 'newer');
    removeRow(row);
    if (newer) affected.add(newer);
  }

  for (const row of affected) {
    if (row.dataset.leaving || !row.dataset.continuation) continue;
    if (neighbour(row, 'older')?.dataset.senderKey === row.dataset.senderKey) continue;
    redrawUserBox(row, false);
    delete row.dataset.continuation;
  }

  // Restored names make rows wider.
  if (affected.size) trimOverflow();
}

// Rows added while the source had no size, measured as soon as it has one.
// trimOverflow calls this as well, so a missing visibilitychange event cannot
// leave a row unmeasured for long.
function remeasurePending() {
  for (const row of container.querySelectorAll('.message-row[data-remeasure]')) {
    row.querySelector('.user-message')?.classList.remove('truncated');
    setupLongMessage(row);
  }
}

// Removes rows beyond messagesLimit and, with trimOffscreen, rows that newer
// messages have pushed past the far edge of the source.
function trimOverflow() {
  const limit = appearance.messagesLimit ?? 50;
  const list = currentLayout === 'list';
  const space = list ? container.clientHeight : container.clientWidth;
  // With no space reported the source is hidden, so only the row limit applies.
  const byExtent = appearance.trimOffscreen !== false && space > 0;
  if (space > 0) remeasurePending();
  const rows = [...container.querySelectorAll('.message-row:not([data-leaving])')];

  let used = 0;
  rows.forEach((row, i) => {
    if (i >= limit) return removeRow(row);
    // Newer rows already fill the source; the row straddling the edge is kept.
    if (byExtent && used >= space) return removeRow(row);
    const box = row.getBoundingClientRect();
    used += list ? box.height : box.width;
  });
}

const SLIDE_IN = { right: 'slideInRight', left: 'slideInLeft', bottom: 'slideInUp', top: 'slideInDown' };

function animationClass() {
  const anim = appearance.animationIn ?? 'slideInRight';
  if (!anim || anim === 'none') return null;
  return `anim-${anim === 'slideInRight' ? SLIDE_IN[newestSide()] : anim}`;
}

// Rows in the list simply stack; the width reveal is bar-only. Images still
// load out of flow, so a row does not grow and shove the list while they arrive.
async function addRowStacked(row) {
  row.style.position = 'absolute';
  row.style.visibility = 'hidden';
  container.prepend(row);
  await waitForImages(row);

  row.style.position = '';
  row.style.visibility = '';
  const anim = animationClass();
  if (anim) row.classList.add(anim);
}

async function addRowSliding(row) {
  // Measured out of flow: an in-flow row would push the bar left while its
  // images load, then jump back when the width reveal starts from zero.
  row.style.position = 'absolute';
  row.style.visibility = 'hidden';
  container.prepend(row);
  await waitForImages(row);

  const target = row.offsetWidth;
  row.style.position = '';
  row.style.visibility = '';
  row.style.overflow = 'hidden';
  row.style.width = '0px';

  const anim = animationClass();
  if (anim) row.classList.add(anim);

  // Two frames: the first commits width 0, the second starts the transition.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    row.style.transition =
      `width ${appearance.animationDuration ?? 0.5}s cubic-bezier(0.16, 1, 0.3, 1)`;
    row.style.width = `${target}px`;
  }));
  setTimeout(() => {
    row.style.width = '';
    row.style.overflow = '';
    row.style.transition = '';
    // Both need the row at its final width.
    setupLongMessage(row);
    trimOverflow();
  }, (appearance.animationDuration ?? 0.5) * 1000 + 60);
}

async function addMessage(msg) {
  const row = buildRow(msg);
  // A hidden source paints nothing and animation frames never run, so the row
  // is just placed and measured once the scene is active again.
  if (document.hidden) {
    container.prepend(row);
    row.dataset.remeasure = '1';
  } else if (currentLayout === 'list') {
    await addRowStacked(row);
  } else {
    await addRowSliding(row);
  }

  // hideAfter 0 means no timer; the row leaves when pushed off the edge.
  const hideAfter = appearance.hideAfter ?? 0;
  if (hideAfter > 0) setTimeout(() => removeRows([row]), hideAfter * 1000);

  trimOverflow();
}

// All events share one queue, so waiting for images cannot reorder messages or
// run a deletion before its message has been added.
let queue = Promise.resolve();
function enqueue(task) {
  queue = queue.then(task).catch((e) => console.error(e));
}

// ------------------------------------------------------------------ event feed

function handle(event) {
  switch (event.type) {
    case 'message':
      return addMessage(event);

    case 'delete':
      removeRows(container.querySelectorAll(`.message-row[data-msgid="${CSS.escape(event.id)}"]`));
      break;

    case 'purge':
      removeRows(container.querySelectorAll(`.message-row[data-sender="${CSS.escape(event.userId)}"]`));
      break;

    case 'clear':
      container.querySelectorAll('.message-row').forEach(removeRow);
      break;
  }
}

// ---------------------------------------------------------------- filtering

// Applied once to every event before it reaches the renderer.
function shouldDrop(event) {
  if (event.type !== 'message') return false;
  const f = CONFIG.filters ?? {};

  // Subs, raids, gift memberships and Super Stickers, as opposed to chat.
  if (event.isEvent && f.showEvents === false) return true;

  if (f.hideCommands && event.rawText.trim().startsWith('!')) return true;
  if (f.ignoreShorterThan && event.rawText.trim().length < f.ignoreShorterThan) return true;

  // Ignores a leading @, so "name" and "@name" both match.
  const strip = (v) => v.trim().toLowerCase().replace(/^@/, '');
  const ignored = String(f.ignoredUsers ?? '').split(',').map(strip).filter(Boolean);
  return ignored.includes(strip(event.displayName));
}

function receive(event) {
  if (shouldDrop(event)) return;
  enqueue(() => handle(event));
}

// -------------------------------------------------------------------- demo

// Open the overlay with ?demo=1 in a regular browser to check the styling
// without waiting for live chat.
function runDemo() {
  const KAPPA = 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0';
  const CHEER = 'https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/animated/100/2.gif';
  const STICKER = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
    + '<circle cx="32" cy="32" r="30" fill="#ffca28"/><circle cx="22" cy="26" r="5"/>'
    + '<circle cx="42" cy="26" r="5"/><path d="M18 40a16 12 0 0 0 28 0" fill="#c1440e"/></svg>');

  const samples = [
    { platform: 'twitch', displayName: 'Chatter', color: '#00FF7F',
      parts: [{ t: 'text', v: 'first message' }] },
    { platform: 'twitch', displayName: 'Chatter', color: '#00FF7F',
      parts: [{ t: 'text', v: 'second message, same person' }] },
    { platform: 'twitch', displayName: 'EmoteFan', color: '#FF69B4',
      parts: [{ t: 'text', v: 'emotes ' }, { t: 'emote', v: KAPPA, alt: 'Kappa' }] },
    { platform: 'youtube', displayName: 'Viewer', color: '',
      parts: [{ t: 'text', v: 'youtube works too' }] },
    { platform: 'youtube', displayName: 'Supporter', color: '', highlight: true,
      parts: [{ t: 'text', v: '[$5.00] nice stream' }] },
    { platform: 'twitch', displayName: 'AbsurdlyLongDisplayNameHere', color: '#FFAA00',
      parts: [{ t: 'text', v: 'a deliberately long message that has to scroll before it settles down' }] },
    { platform: 'twitch', displayName: 'Moderator', color: '#00B5AD', highlight: true,
      parts: [{ t: 'text', v: 'announcements look like this' }] },
    { platform: 'twitch', displayName: 'Subscriber', color: '#FF4500', highlight: true, isEvent: true,
      parts: [{ t: 'text', v: 'subscribed for 6 months! - still here' }] },
    { platform: 'twitch', displayName: 'Raider', color: '#1E90FF', highlight: true, isEvent: true,
      parts: [{ t: 'text', v: 'raiding with 12 viewers' }] },
    { platform: 'twitch', displayName: 'Gifter', color: '#FF69B4', highlight: true, isEvent: true,
      parts: [{ t: 'text', v: 'is gifting 20 subs to the community!' }] },
    { platform: 'twitch', displayName: 'Cheerer', color: '#9146FF',
      parts: [{ t: 'emote', v: CHEER, alt: 'Cheer100' }, { t: 'text', v: '100 have fun' }] },
    { platform: 'youtube', displayName: 'StickerFan', color: '', highlight: true,
      parts: [{ t: 'text', v: '[2,00 EUR] ' }, { t: 'emote', v: STICKER, alt: 'sticker' }] }
  ];

  samples.forEach((sample, i) => {
    setTimeout(() => receive({
      type: 'message',
      id: `demo-${i}`,
      userId: `demo-${sample.displayName.toLowerCase()}`,
      badges: [], avatar: null, isAction: false, highlight: false, isEvent: false,
      rawText: sample.parts.map((p) => (p.t === 'text' ? p.v : p.alt)).join(''),
      ...sample
    }), 400 + i * 700);
  });
}

// --------------------------------------------------------------------- notice

// Shows text pinned to the right of the source, hidden again after `seconds`
// (0 = until replaced). null hides it.
let noticeTimer = null;
function showNotice(text, seconds = 0) {
  const el = document.getElementById('notice');
  clearTimeout(noticeTimer);
  el.textContent = text ?? '';
  el.hidden = !text;
  if (text && seconds > 0) noticeTimer = setTimeout(() => showNotice(null), seconds * 1000);
}

// -------------------------------------------------------------------- startup

function start() {
  applyAppearance(CONFIG.appearance ?? {});

  const log = (scope) => (message) => console.log(`[${scope}] ${message}`);

  emotes = CONFIG.emotes?.enabled === false
    ? null
    : window.createEmoteIndex?.({ config: CONFIG.emotes ?? {}, target: emoteTarget, log: log('emotes') });
  emotes?.loadGlobals();

  if (CONFIG.twitch?.enabled && window.startTwitch) {
    window.startTwitch({
      config: CONFIG.twitch,
      // Only request API data that will actually be shown.
      features: {
        badges: eitherLayout((a) => badgesEnabled(a)),
        avatars: eitherLayout((a) => Boolean(a.showAvatar)),
        cheermotes: CONFIG.emotes?.enabled !== false && CONFIG.emotes?.cheermotes !== false
      },
      emotes,
      target: emoteTarget,
      avatarPixels: () => Number(appearance.avatarPixels ?? 0),
      emit: receive,
      notice: showNotice,
      log: log('twitch')
    });
  }
  if (CONFIG.youtube?.enabled && window.startYouTube) {
    window.startYouTube({ config: CONFIG.youtube, emit: receive, log: log('youtube') });
  }

  if (new URLSearchParams(location.search).has('demo')) runDemo();
}

start();
