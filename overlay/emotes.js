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

// Picks the best file 7TV actually provides; webp first, for animation.
function sevenTvUrl(emote) {
  const host = emote?.data?.host ?? emote?.host;
  if (!host?.url) return null;
  const have = new Set((host.files ?? []).map((f) => f.name));
  const file = ['2x.webp', '2x.avif', '2x.png', '1x.webp', '1x.png']
    .find((f) => have.has(f)) ?? '2x.webp';
  return `https:${host.url}/${file}`;
}

function bttvUrl(emote) {
  return `https://cdn.betterttv.net/emote/${emote.id}/2x.webp`;
}

function ffzUrl(emote) {
  const raw = emote.urls?.['2'] ?? emote.urls?.['1'] ?? emote.urls?.['4'];
  if (!raw) return null;
  return raw.startsWith('http') ? raw : `https:${raw}`;
}

function createEmoteIndex({ config = {}, log = () => {} } = {}) {
  const sources = new Map();       // source label -> Map(emote name -> image url)
  let emoteUrls = new Map();       // merged view used by decorate
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
  // disappear on the next reload.
  function rebuild() {
    const urls = new Map();
    const blocked = new Set();
    for (const label of SOURCE_ORDER) {
      for (const [name, url] of sources.get(label) ?? []) {
        if (isBlocked(name)) blocked.add(name);
        else urls.set(name, url);
      }
    }
    emoteUrls = urls;
    blockedSeen = blocked;
  }

  // Catches per provider, so one failure does not reject Promise.all for the
  // others. A failed reload keeps that provider's previous emotes.
  async function loadFrom(label, fn) {
    try {
      const entries = new Map();
      await fn((name, url) => { if (name && url) entries.set(name, url); });
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
          for (const e of set.emoticons ?? []) add(e.name, ffzUrl(e));
        }
      }));
    }
    if (config.bttv !== false) {
      jobs.push(loadFrom('bttv global', async (add) => {
        const data = await getJson('https://api.betterttv.net/3/cached/emotes/global');
        for (const e of data) add(e.code, bttvUrl(e));
      }));
    }
    if (config.sevenTv !== false) {
      jobs.push(loadFrom('7tv global', async (add) => {
        const data = await getJson('https://7tv.io/v3/emote-sets/global');
        for (const e of data.emotes ?? []) add(e.name, sevenTvUrl(e));
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
          for (const e of set.emoticons ?? []) add(e.name, ffzUrl(e));
        }
      }));
    }
    if (config.bttv !== false) {
      jobs.push(loadFrom('bttv channel', async (add) => {
        const data = await getJson(`https://api.betterttv.net/3/cached/users/twitch/${twitchId}`);
        for (const e of [...(data.channelEmotes ?? []), ...(data.sharedEmotes ?? [])]) add(e.code, bttvUrl(e));
      }));
    }
    if (config.sevenTv !== false) {
      jobs.push(loadFrom('7tv channel', async (add) => {
        const data = await getJson(`https://7tv.io/v3/users/twitch/${twitchId}`);
        for (const e of data.emote_set?.emotes ?? []) add(e.name, sevenTvUrl(e));
      }));
    }
    await Promise.all(jobs);
    log(`${emoteUrls.size} emotes available`
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
        // Blocked emotes are not in emoteUrls, so they are checked by exact
        // name here; exact matching leaves ordinary words alone.
        if (blockedSeen.has(token)) {
          if (!hideBlocked) pushText(token);
          continue;
        }
        const url = emoteUrls.get(token);
        if (url) out.push({ t: 'emote', v: url, alt: token });
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
    get size() { return emoteUrls.size; },
    get blocked() { return [...blockedSeen]; }
  };
}

  window.createEmoteIndex = createEmoteIndex;
})();
