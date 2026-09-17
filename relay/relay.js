/**
 * YouTube live chat relay. Runs as a Cloudflare Worker, or locally through
 * server.mjs.
 *
 * YouTube's chat endpoint sends no CORS headers, so the overlay cannot fetch it
 * directly. The relay is stateless: the client sends the continuation token
 * with every poll.
 *
 *   GET  /open?channel=@handle   -> { videoId, apiKey, clientVersion, continuation }
 *   GET  /open?videoId=ID        -> same
 *   POST /poll                   body { apiKey, clientVersion, continuation }
 *                                -> { messages, continuation, timeoutMs }
 *   GET  /diag?channel=@handle   -> resolution diagnostics
 *
 * Clients send /poll as text/plain, which avoids a CORS preflight.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Browser-like headers. The consent cookies stop YouTube serving a consent page
// instead of the requested one.
const FETCH_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'CONSENT=YES+cb; SOCS=CAISNQgREitib3E3WkRRNU1UWTNPRE00TWpNNU5nNDVOakl6TnpVNU1EQXlNamMyTkRJMwgB'
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

// Anyone who knows the relay's address can call it, so it only fetches YouTube
// pages; otherwise a crafted channel URL could make it probe its own network.
// Redirects are followed manually for the same reason.
function isYouTubeUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    const host = hostname.toLowerCase();
    return protocol === 'https:' && (host === 'youtube.com' || host.endsWith('.youtube.com'));
  } catch {
    return false;
  }
}

async function getText(url) {
  for (let hop = 0; hop < 5; hop++) {
    if (!isYouTubeUrl(url)) throw new Error('refusing to fetch a non-YouTube address');
    const res = await fetch(url, { headers: FETCH_HEADERS, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (location) {
      url = new URL(location, url).href;
      continue;
    }
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.text();
  }
  throw new Error(`GET ${url} -> too many redirects`);
}

// Accepts an @handle, a channel ID or name, or a youtube.com / youtu.be URL.
function checkChannelRef(ref) {
  let ok;
  if (/^https?:\/\//i.test(ref)) {
    try {
      const host = new URL(ref).hostname.toLowerCase();
      ok = host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
    } catch {
      ok = false;
    }
  } else {
    ok = /^[^\s/?#\\]{1,100}$/.test(ref);
  }
  if (!ok) throw new Error('channel must be an @handle, a channel ID or a YouTube address');
}

// Extracts a JSON object assigned in the page (`var ytInitialData = {...}` or
// `window["ytInitialData"] = {...}`) by matching braces.
function extractJson(html, name) {
  const at = html.search(
    new RegExp(`(?:var\\s+${name}|window\\s*\\[\\s*["']${name}["']\\s*\\]|${name})\\s*=\\s*\\{`)
  );
  if (at === -1) return null;

  const start = html.indexOf('{', at);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

// YouTube's public web client key: the same for every visitor, not a secret.
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const CLIENT_VERSION = '2.20240101.00.00';
const LIVE_TAB_PARAMS = 'EgdzdHJlYW1z';   // the channel's "Live" tab

async function innertube(path, body) {
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/${path}?key=${INNERTUBE_KEY}&prettyPrint=false`,
    {
      method: 'POST',
      headers: { ...FETCH_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: CLIENT_VERSION } },
        ...body
      })
    }
  );
  if (!res.ok) throw new Error(`innertube ${path} -> ${res.status}`);
  return res.json();
}

// Finds a channel's live video via the innertube API. Returns candidate ids,
// and notLive when YouTube reports that nothing is on air.
async function liveCandidatesViaInnertube(ref) {
  const ids = [];
  const push = (id) => { if (id && !ids.includes(id)) ids.push(id); };

  // resolve_url on /live returns a watch endpoint for the current broadcast.
  let notLive = false;
  try {
    const resolved = await innertube('navigation/resolve_url', { url: liveUrlFor(ref) });
    const watching = resolved?.endpoint?.watchEndpoint?.videoId;
    if (watching) push(watching);
    // A browse endpoint means /live fell back to the channel page: not live.
    // Ended streams keep a working chat page for a while, so without this
    // check they could be picked up as live.
    else if (resolved?.endpoint?.browseEndpoint) notLive = true;
  } catch { /* fall through to the Live tab */ }

  if (ids.length) return { ids, notLive: false };
  if (notLive) return { ids, notLive: true };

  let browseId = /^UC[\w-]{22}$/.test(ref) ? ref : null;
  if (!browseId) {
    const url = ref.startsWith('@')
      ? `https://www.youtube.com/${ref}`
      : `https://www.youtube.com/c/${ref}`;
    const resolved = await innertube('navigation/resolve_url', { url });
    browseId = resolved?.endpoint?.browseEndpoint?.browseId
      ?? resolved?.onResponseReceivedActions?.[0]?.navigateAction?.endpoint?.browseEndpoint?.browseId;
  }
  if (!browseId) return { ids, notLive: false };

  // Fallback: the Live tab is sorted by date, not by what is on air, so the
  // current stream may be further down. Callers verify each candidate.
  const streams = JSON.stringify(await innertube('browse', { browseId, params: LIVE_TAB_PARAMS }));
  for (const m of streams.matchAll(
    /"videoId":"([\w-]{11})"(?:(?!"videoId")[\s\S]){0,2000}?(?:BADGE_STYLE_TYPE_LIVE_NOW|"style":"LIVE")/g
  )) push(m[1]);
  for (const m of streams.matchAll(/"videoId":"([\w-]{11})"/g)) push(m[1]);

  return { ids: ids.slice(0, 4), notLive: false };
}

function liveUrlFor(ref) {
  // Rebuilt from the path, so the host is always YouTube's.
  if (/^https?:\/\//i.test(ref)) {
    return `https://www.youtube.com${new URL(ref).pathname.replace(/\/+$/, '')}/live`;
  }
  if (ref.startsWith('@')) return `https://www.youtube.com/${ref}/live`;
  if (/^UC[\w-]{22}$/.test(ref)) return `https://www.youtube.com/channel/${ref}/live`;
  return `https://www.youtube.com/c/${ref}/live`;
}

// Candidate video ids from a channel's /live HTML page, most reliable first.
// Not simply the first "videoId" in the page: that is often a recommendation.
function candidateVideoIds(html) {
  const ids = [];
  const push = (id) => { if (id && !ids.includes(id)) ids.push(id); };

  push(html.match(/<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/)?.[1]);
  push(html.match(/"videoDetails"\s*:\s*\{[^{}]{0,400}?"videoId"\s*:\s*"([\w-]{11})"/)?.[1]);
  push(html.match(/"currentVideoEndpoint"[\s\S]{0,300}?"videoId"\s*:\s*"([\w-]{11})"/)?.[1]);

  // Channel-page fallback: an entry explicitly badged as live.
  for (const m of html.matchAll(/"videoId"\s*:\s*"([\w-]{11})"[\s\S]{0,1500}?BADGE_STYLE_TYPE_LIVE_NOW/g)) {
    push(m[1]);
  }
  return ids;
}

// Short-lived memory of the last video that worked per channel, used as an
// extra candidate when resolution finds nothing. Needs the Cache API, so it is
// skipped when running outside Cloudflare.
const RESOLVE_TTL_SECONDS = 300;

function resolveCacheKey(ref) {
  return new Request(`https://resolve.invalid/${encodeURIComponent(ref)}`);
}

async function rememberVideoId(ref, videoId) {
  if (typeof caches === 'undefined') return;      // running outside Workers
  try {
    await caches.default.put(resolveCacheKey(ref), new Response(JSON.stringify({ videoId }), {
      headers: {
        'Cache-Control': `max-age=${RESOLVE_TTL_SECONDS}`,
        'Content-Type': 'application/json'
      }
    }));
  } catch { /* caching is an optimisation, never a requirement */ }
}

async function recallVideoId(ref) {
  if (typeof caches === 'undefined') return null;
  try {
    const hit = await caches.default.match(resolveCacheKey(ref));
    return hit ? (await hit.json()).videoId : null;
  } catch {
    return null;
  }
}

// Accepts a bare video id, a watch/live URL, an @handle, or a UC... channel id.
async function resolveVideoId(channelRef, explicitVideoId) {
  if (explicitVideoId) {
    if (!/^[\w-]{11}$/.test(explicitVideoId)) throw new Error('invalid videoId');
    return { videoId: explicitVideoId, candidates: [explicitVideoId] };
  }

  const ref = String(channelRef || '').trim();
  if (!ref) throw new Error('no channel configured');
  checkChannelRef(ref);

  if (/^https?:\/\//i.test(ref)) {
    const direct = ref.match(/[?&]v=([\w-]{11})|\/live\/([\w-]{11})|youtu\.be\/([\w-]{11})/);
    const id = direct?.[1] || direct?.[2] || direct?.[3];
    if (id) return { videoId: id, candidates: [id] };
  } else if (/^[\w-]{11}$/.test(ref)) {
    return { videoId: ref, candidates: [ref] };
  }

  const candidates = [];
  const push = (id) => { if (id && !candidates.includes(id)) candidates.push(id); };
  const notes = [];

  // 1. The innertube API.
  let declaredOffline = false;
  try {
    const found = await liveCandidatesViaInnertube(ref);
    declaredOffline = found.notLive;
    for (const id of found.ids) push(id);
  } catch (err) {
    notes.push(`innertube: ${err.message}`);
  }

  // 2. The channel's HTML page. Skipped when YouTube reports the channel
  //    offline, since it is large and fetched on every check while waiting.
  let htmlBytes = 0;
  if (!candidates.length && !declaredOffline) {
    try {
      const html = await getText(liveUrlFor(ref));
      htmlBytes = html.length;
      for (const id of candidateVideoIds(html)) push(id);
      if (!candidates.length && !/"isLive"\s*:\s*true|"isLiveNow"\s*:\s*true|hlsManifestUrl/.test(html)) {
        notes.push(`channel page had no live markers (${htmlBytes} bytes)`);
      }
    } catch (err) {
      notes.push(`channel page: ${err.message}`);
    }
  }

  // 3. The last video that worked, unless the channel is reported offline.
  if (!declaredOffline) push(await recallVideoId(ref));

  if (!candidates.length) {
    throw new Error(declaredOffline
      ? 'channel is not live right now'
      : `channel is not live right now${notes.length ? ` [${notes.join('; ')}]` : ''}`);
  }
  return { videoId: candidates[0], candidates };
}

function continuationOf(node) {
  return (
    node?.invalidationContinuationData ?? node?.timedContinuationData ?? node?.reloadContinuationData
  )?.continuation;
}

// Returns a usable chat session for one video, or null if that video has none.
async function tryOpenChat(videoId) {
  const html = await getText(`https://www.youtube.com/live_chat?v=${videoId}&is_popout=1`);

  const apiKey = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1];
  const clientVersion = html.match(/"clientVersion"\s*:\s*"([\d.]+)"/)?.[1] ?? CLIENT_VERSION;
  const live = extractJson(html, 'ytInitialData')?.contents?.liveChatRenderer;

  // Prefer the unfiltered "Live chat" view over the default "Top chat".
  const views = live?.header?.liveChatHeaderRenderer?.viewSelector
    ?.sortFilterSubMenuRenderer?.subMenuItems ?? [];
  const unfiltered = views.find((v) => /live chat/i.test(v.title ?? ''));
  const continuation = continuationOf(unfiltered?.continuation)
    ?? continuationOf(live?.continuations?.[0]);

  if (!apiKey || !continuation) return null;
  return { videoId, apiKey, clientVersion, continuation, filtered: !unfiltered };
}

async function open(channelRef, explicitVideoId) {
  const { candidates } = await resolveVideoId(channelRef, explicitVideoId);

  // Candidates are guesses; use the first one with a live chat.
  for (const videoId of candidates.slice(0, 4)) {
    const session = await tryOpenChat(videoId);
    if (session) {
      if (!explicitVideoId) await rememberVideoId(String(channelRef).trim(), videoId);
      return session;
    }
  }
  throw new Error(candidates.length === 1
    ? 'live chat is unavailable for this video'
    : `no live chat found on any candidate video (${candidates.slice(0, 4).join(', ')})`);
}

function textPartsFromRuns(runs = []) {
  const parts = [];
  for (const run of runs) {
    if (run.text) {
      parts.push({ t: 'text', v: run.text });
    } else if (run.emoji) {
      const e = run.emoji;
      const thumbs = e.image?.thumbnails ?? [];
      const url = thumbs[thumbs.length - 1]?.url;
      if (e.isCustomEmoji && url) parts.push({ t: 'emote', v: url, alt: e.shortcuts?.[0] ?? '' });
      else parts.push({ t: 'text', v: e.emojiId ?? e.shortcuts?.[0] ?? '' });
    }
  }
  return parts;
}

const ICON_CHIPS = {
  MODERATOR: { label: 'MOD', color: '#5e84f1' },
  OWNER: { label: 'HOST', color: '#ffd600' },
  VERIFIED: { label: 'VERIFIED', color: '#999999' }
};

function badgesFromAuthor(authorBadges = []) {
  const out = [];
  for (const b of authorBadges) {
    const r = b.liveChatAuthorBadgeRenderer;
    if (!r) continue;
    const thumbs = r.customThumbnail?.thumbnails;
    if (thumbs?.length) {
      out.push({ url: thumbs[thumbs.length - 1].url, title: r.tooltip ?? 'member' });
    } else {
      const chip = ICON_CHIPS[r.icon?.iconType];
      if (chip) out.push({ chip: chip.label, color: chip.color, title: r.tooltip ?? chip.label });
    }
  }
  return out;
}

function normalize(action) {
  const item = action.addChatItemAction?.item;
  if (!item) return null;

  const r = item.liveChatTextMessageRenderer
    ?? item.liveChatPaidMessageRenderer
    ?? item.liveChatMembershipItemRenderer;
  if (!r) return null;

  const isPaid = Boolean(item.liveChatPaidMessageRenderer);
  const isMember = Boolean(item.liveChatMembershipItemRenderer);

  let parts = textPartsFromRuns(r.message?.runs);
  if (isMember && !parts.length) parts = textPartsFromRuns(r.headerSubtext?.runs);
  if (isPaid) {
    const amount = r.purchaseAmountText?.simpleText;
    if (amount) parts.unshift({ t: 'text', v: `[${amount}] ` });
  }
  if (!parts.length) return null;

  const thumbs = r.authorPhoto?.thumbnails ?? [];
  return {
    type: 'message',
    platform: 'youtube',
    id: r.id,
    userId: r.authorExternalChannelId ?? r.id,
    // Handles arrive as "@name"; shown without the @.
    displayName: (r.authorName?.simpleText ?? 'Unknown').replace(/^@/, ''),
    color: '',
    badges: badgesFromAuthor(r.authorBadges),
    avatar: thumbs[thumbs.length - 1]?.url ?? null,
    parts,
    rawText: parts.map((p) => (p.t === 'text' ? p.v : p.alt)).join(''),
    isAction: false,
    highlight: isPaid || isMember,
    // Send time in ms, used by the client to space out batches.
    ts: Number(r.timestampUsec ?? 0) / 1000 || 0
  };
}

async function poll({ apiKey, clientVersion, continuation }) {
  if (!apiKey || !continuation) throw new Error('missing apiKey or continuation');

  // YouTube occasionally rejects valid polls with 403, 429 or 5xx; retry briefly.
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(
      `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${encodeURIComponent(apiKey)}&prettyPrint=false`,
      {
        method: 'POST',
        headers: { ...FETCH_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: { client: { clientName: 'WEB', clientVersion } },
          continuation
        })
      }
    );
    if (res.ok) break;
    if (![403, 429, 500, 502, 503].includes(res.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
  }
  if (!res.ok) throw new Error(`poll -> ${res.status}`);

  const live = (await res.json()).continuationContents?.liveChatContinuation;
  if (!live) throw new Error('chat ended or continuation expired');

  const messages = [];
  for (const action of live.actions ?? []) {
    const del = action.markChatItemAsDeletedAction;
    if (del) { messages.push({ type: 'delete', platform: 'youtube', id: del.targetItemId }); continue; }

    const purge = action.markChatItemsByAuthorAsDeletedAction;
    if (purge) {
      messages.push({ type: 'purge', platform: 'youtube', userId: purge.externalChannelId });
      continue;
    }
    const msg = normalize(action);
    if (msg) messages.push(msg);
  }

  const c = live.continuations?.[0];
  const next = continuationOf(c);
  if (!next) throw new Error('no continuation returned');
  const timeout = c?.invalidationContinuationData?.timeoutMs ?? c?.timedContinuationData?.timeoutMs;

  return { messages, continuation: next, timeoutMs: Math.min(Math.max(timeout ?? 2000, 1000), 10000) };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    try {
      if (url.pathname === '/open' || url.pathname === '/') {
        return json(await open(url.searchParams.get('channel'), url.searchParams.get('videoId')));
      }
      // What YouTube returns to this relay, for debugging channel resolution.
      if (url.pathname === '/diag') {
        const ref = (url.searchParams.get('channel') ?? '').trim();
        checkChannelRef(ref);
        const out = { channel: ref, remembered: await recallVideoId(ref) };

        try {
          const found = await liveCandidatesViaInnertube(ref);
          out.innertube = found.ids;
          out.youtubeSaysOffline = found.notLive;
        } catch (e) {
          out.innertube = `error: ${e.message}`;
        }

        try {
          const html = await getText(liveUrlFor(ref));
          out.pageBytes = html.length;
          out.pageLooksLive = /"isLive"\s*:\s*true|"isLiveNow"\s*:\s*true/.test(html);
          // A real wall replaces the page; a mere link to consent.youtube.com does not.
          out.consentWall = !html.includes('ytInitialData') && /consent/i.test(html);
          out.pageCandidates = candidateVideoIds(html);
        } catch (e) {
          out.pageError = e.message;
        }

        const toCheck = [...new Set([
          ...(Array.isArray(out.innertube) ? out.innertube : []),
          ...(out.pageCandidates ?? [])
        ])].slice(0, 4);
        out.checked = [];
        for (const id of toCheck) {
          out.checked.push({ videoId: id, hasLiveChat: Boolean(await tryOpenChat(id)) });
        }
        return json(out);
      }

      if (url.pathname === '/poll') {
        const raw = request.method === 'POST'
          ? await request.text()
          : url.searchParams.get('state');
        return json(await poll(JSON.parse(raw || '{}')));
      }
      return json({ error: `unknown path ${url.pathname}` }, 404);
    } catch (err) {
      // An error status lets clients distinguish failures from empty results.
      return json({ error: String(err.message ?? err) }, 502);
    }
  }
};
