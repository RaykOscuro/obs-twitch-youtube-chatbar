/* Third-party emote index for 7TV, BetterTTV and FrankerFaceZ: global sets plus
   a channel's own, keyed by Twitch channel id. Classic script rather than a
   module, so it also works from file://. */
(function () {

// Identifies this overlay to the emote APIs. Chromium drops this header from
// fetch requests (crbug 571722), so it has no effect in OBS.
const HEADERS = { 'User-Agent': 'obs-twitch-youtube-chatbar/1.0' };

// Merge order: later sources win, so channel sets beat globals.
const SOURCE_ORDER = ['ffz global', 'bttv global', '7tv global', 'ffz channel', 'bttv channel', '7tv channel'];

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const absolute = (raw) => (raw.startsWith('http') ? raw : `https:${raw}`);

// The files a provider offers for one emote, with each file's pixel height.
// 7TV reports the real dimensions; webp comes first, for animation.
function sevenTvFiles(emote) {
  const host = emote?.data?.host ?? emote?.host;
  if (!host?.url) return [];
  const byHeight = new Map();
  for (const file of host.files ?? []) {
    const rank = ['.webp', '.avif', '.png', '.gif'].indexOf(file.name.slice(file.name.lastIndexOf('.')));
    if (rank === -1 || !file.height) continue;
    const seen = byHeight.get(file.height);
    if (!seen || rank < seen.rank) byHeight.set(file.height, { rank, url: `https:${host.url}/${file.name}` });
  }
  return [...byHeight].map(([height, { url }]) => ({ height, url }));
}

function bttvFiles(emote) {
  return [28, 56, 112].map((height, i) => ({
    height,
    url: `https://cdn.betterttv.net/emote/${emote.id}/${i + 1}x.webp`
  }));
}

function ffzFiles(emote) {
  const native = Number(emote.height) || 32;
  return [['1', 1], ['2', 2], ['4', 4]]
    .filter(([key]) => emote.urls?.[key])
    .map(([key, factor]) => ({ height: native * factor, url: absolute(emote.urls[key]) }));
}

// Picks the file to display and the height to display it at. A file within
// target.snap pixels of the wanted height is used at its own size, so the
// browser never resamples it; otherwise the smallest file above the wanted
// height is scaled down, which looks better than scaling one up.
function pickEmoteImage(files, target) {
  if (!files.length) return null;
  const sorted = [...files].sort((a, b) => a.height - b.height);

  const fitting = sorted.find((f) => Math.abs(f.height - target.device) <= target.snap);
  if (fitting) return { url: fitting.url, h: Math.round(fitting.height / target.dpr) };

  const larger = sorted.find((f) => f.height >= target.device) ?? sorted[sorted.length - 1];
  return { url: larger.url, h: null };
}

// target is { device, dpr, snap }: the height an emote should end up at, in
// device pixels, and how far off a file may be to still be used unscaled.
function createEmoteIndex({ config = {}, target, log = () => {} } = {}) {
  let wanted = target ?? { device: 31, dpr: 1, snap: 4 };
  const sources = new Map();       // source label -> Map(emote name -> files)
  let emoteImages = new Map();     // merged view used by decorate
  let blockedSeen = new Set();
  const patterns = (config.blocklist ?? [])
    .map((p) => String(p).toLowerCase())
    .filter(Boolean);
  const hideBlocked = config.blockedRender === 'hide';

  const isBlocked = (name) => {
    if (!name) return false;
    const n = String(name).toLowerCase();
    return patterns.some((p) => n.includes(p));
  };

  // Rebuilt from all sources after every load, so emotes a channel removed
  // disappear on the next reload. The file lists are kept, so the images can be
  // picked again when the text size changes.
  function rebuild() {
    const images = new Map();
    const blocked = new Set();
    for (const label of SOURCE_ORDER) {
      for (const [name, files] of sources.get(label) ?? []) {
        if (isBlocked(name)) {
          blocked.add(name);
          continue;
        }
        const image = pickEmoteImage(files, wanted);
        if (image) images.set(name, image);
      }
    }
    emoteImages = images;
    blockedSeen = blocked;
  }

  // Catches per provider, so one failure does not reject Promise.all for the
  // others. A failed reload keeps that provider's previous emotes.
  async function loadFrom(label, fn) {
    try {
      const entries = new Map();
      await fn((name, files) => { if (name && files?.length) entries.set(name, files); });
      sources.set(label, entries);
      rebuild();
      log(`${label}: ${entries.size} emotes`);
    } catch (e) {
      log(`${label} unavailable (${e.message})`);
    }
  }

  async function loadGlobals() {
    const jobs = [];
    if (config.ffz !== false) {
      jobs.push(loadFrom('ffz global', async (add) => {
        const data = await getJson('https://api.frankerfacez.com/v1/set/global');
        for (const set of Object.values(data.sets ?? {})) {
          for (const e of set.emoticons ?? []) add(e.name, ffzFiles(e));
        }
      }));
    }
    if (config.bttv !== false) {
      jobs.push(loadFrom('bttv global', async (add) => {
        const data = await getJson('https://api.betterttv.net/3/cached/emotes/global');
        for (const e of data) add(e.code, bttvFiles(e));
      }));
    }
    if (config.sevenTv !== false) {
      jobs.push(loadFrom('7tv global', async (add) => {
        const data = await getJson('https://7tv.io/v3/emote-sets/global');
        for (const e of data.emotes ?? []) add(e.name, sevenTvFiles(e));
      }));
    }
    await Promise.all(jobs);
  }

  async function loadChannel(twitchId) {
    if (!twitchId) return;
    const jobs = [];
    if (config.ffz !== false) {
      jobs.push(loadFrom('ffz channel', async (add) => {
        const data = await getJson(`https://api.frankerfacez.com/v1/room/id/${twitchId}`);
        for (const set of Object.values(data.sets ?? {})) {
          for (const e of set.emoticons ?? []) add(e.name, ffzFiles(e));
        }
      }));
    }
    if (config.bttv !== false) {
      jobs.push(loadFrom('bttv channel', async (add) => {
        const data = await getJson(`https://api.betterttv.net/3/cached/users/twitch/${twitchId}`);
        for (const e of [...(data.channelEmotes ?? []), ...(data.sharedEmotes ?? [])]) add(e.code, bttvFiles(e));
      }));
    }
    if (config.sevenTv !== false) {
      jobs.push(loadFrom('7tv channel', async (add) => {
        const data = await getJson(`https://7tv.io/v3/users/twitch/${twitchId}`);
        for (const e of data.emote_set?.emotes ?? []) add(e.name, sevenTvFiles(e));
      }));
    }
    await Promise.all(jobs);
    log(`${emoteImages.size} emotes available`
      + (blockedSeen.size ? `, ${blockedSeen.size} blocked (${[...blockedSeen].join(', ')})` : ''));
  }

  // Replaces third-party emote names in text parts and applies the blocklist.
  // Expects buildParts output, where Twitch's own emotes are already parts.
  function decorate(parts) {
    const out = [];

    const pushText = (text) => {
      if (!text) return;
      const last = out[out.length - 1];
      if (last?.t === 'text') last.v += text;
      else out.push({ t: 'text', v: text });
    };

    for (const part of parts) {
      if (part.t === 'emote') {
        // A blocked name can also arrive as a native Twitch/sub emote.
        if (isBlocked(part.alt)) pushText(hideBlocked ? '' : part.alt);
        else out.push(part);
        continue;
      }
      for (const token of part.v.split(/(\s+)/)) {
        if (!token) continue;
        // Blocked emotes are not in the index, so they are checked by exact
        // name here; exact matching leaves ordinary words alone.
        if (blockedSeen.has(token)) {
          if (!hideBlocked) pushText(token);
          continue;
        }
        const image = emoteImages.get(token);
        if (image) out.push({ t: 'emote', v: image.url, alt: token, h: image.h });
        else pushText(token);
      }
    }

    // Collapse spaces left behind by removed emotes.
    for (const p of out) if (p.t === 'text') p.v = p.v.replace(/\s{2,}/g, ' ');
    if (out[0]?.t === 'text') out[0].v = out[0].v.replace(/^\s+/, '');
    const last = out[out.length - 1];
    if (last?.t === 'text') last.v = last.v.replace(/\s+$/, '');
    return out.filter((p) => p.t !== 'text' || p.v !== '');
  }

  return {
    loadGlobals,
    loadChannel,
    decorate,
    isBlocked,
    // Called when the text size changes, to re-pick from the files already held.
    setTarget(next) {
      wanted = next;
      rebuild();
    },
    get size() { return emoteImages.size; },
    get blocked() { return [...blockedSeen]; }
  };
}

  window.createEmoteIndex = createEmoteIndex;
  window.pickEmoteImage = pickEmoteImage;
})();
