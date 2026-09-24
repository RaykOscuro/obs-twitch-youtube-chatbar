/* Twitch chat over Twitch's IRC WebSocket, logged in anonymously (read-only).
   Badges and avatars are optional and come from the Twitch API (twitch-api.js).
   Classic script rather than a module, so it also works from file://. */
(function () {
  const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
  // Longest a message waits for its sender's avatar before it is shown without.
  const AVATAR_WAIT_MS = 1500;
  // Twitch itself pings about every 5 minutes. After a minute without data the
  // connection is probed; no reply within 15 seconds replaces it.
  const IDLE_PROBE_MS = 60000;
  const PROBE_TIMEOUT_MS = 15000;

  // Badge sets grouped for appearance.badgeKinds. Sets not listed here, such as
  // convention and charity badges, count as "event".
  const BADGE_KINDS = {
    broadcaster: 'role', moderator: 'role', vip: 'role', staff: 'role', admin: 'role',
    global_mod: 'role', partner: 'role', 'artist-badge': 'role', 'game-developer': 'role',
    subscriber: 'subscriber', founder: 'subscriber',
    bits: 'channel', 'bits-leader': 'channel', 'bits-charity': 'channel', moments: 'channel',
    'sub-gifter': 'channel', 'sub-gift-leader': 'channel', 'hype-train': 'channel',
    predictions: 'channel',
    premium: 'account', turbo: 'account', 'glhf-pledge': 'account',
    no_audio: 'account', no_video: 'account'
  };

  const TAG_UNESCAPE = { '\\s': ' ', '\\:': ';', '\\\\': '\\', '\\r': '\r', '\\n': '\n' };

  function unescapeTagValue(v) {
    return v.replace(/\\[srn:\\]/g, (m) => TAG_UNESCAPE[m] ?? m);
  }

  // Parses one raw IRC line into { tags, prefix, command, params }, e.g.
  //   '@id=abc;mod=1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #channel :hello there'
  // becomes
  //   { tags: { id: 'abc', mod: '1' },
  //     prefix: 'bob!bob@bob.tmi.twitch.tv',
  //     command: 'PRIVMSG',
  //     params: ['#channel', 'hello there'] }
  function parseIRC(line) {
    let rest = line;
    const tags = {};

    if (rest.startsWith('@')) {
      const sp = rest.indexOf(' ');
      for (const pair of rest.slice(1, sp).split(';')) {
        const eq = pair.indexOf('=');
        if (eq === -1) tags[pair] = true;
        else tags[pair.slice(0, eq)] = unescapeTagValue(pair.slice(eq + 1));
      }
      rest = rest.slice(sp + 1);
    }

    let prefix = null;
    if (rest.startsWith(':')) {
      const sp = rest.indexOf(' ');
      prefix = rest.slice(1, sp);
      rest = rest.slice(sp + 1);
    }

    const params = [];
    while (rest.length) {
      if (rest.startsWith(':')) { params.push(rest.slice(1)); break; }
      const sp = rest.indexOf(' ');
      if (sp === -1) { params.push(rest); break; }
      params.push(rest.slice(0, sp));
      rest = rest.slice(sp + 1);
    }

    return { tags, prefix, command: params.shift(), params };
  }

  // USERNOTICE kinds shown as events; their wording comes in system-msg.
  // Announcements are handled apart, as ordinary messages.
  const EVENT_NOTICES = new Set([
    'sub', 'resub', 'subgift', 'anonsubgift', 'submysterygift', 'giftpaidupgrade',
    'anongiftpaidupgrade', 'primepaidupgrade', 'standardpayforward', 'communitypayforward',
    'raid', 'bitsbadgetier', 'viewermilestone'
  ]);

  // A community gift sends one bomb notice and then one notice per recipient.
  // The recipients are folded into the bomb for this long, so a 20-sub bomb
  // does not push every chat message off the bar.
  const GIFT_BOMB_MS = 30000;

  // Twitch renders every emote at these heights.
  const EMOTE_FILES = [[28, '1.0'], [56, '2.0'], [112, '3.0']];
  // The profile picture sizes Twitch serves.
  const AVATAR_SIZES = [28, 50, 70];

  // pickEmoteImage comes from emotes.js, which index.html loads first; without
  // it the middle size is used and scaled by the browser.
  function emoteImage(id, target) {
    const files = EMOTE_FILES.map(([height, size]) => ({
      height,
      url: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/${size}`
    }));
    return window.pickEmoteImage?.(files, target) ?? { url: files[1].url, h: null };
  }

  // Splits text into text and emote parts using the IRC emotes tag. Its ranges
  // count code points, not UTF-16 units, hence Array.from: string indices would
  // misplace every emote after an emoji.
  function buildParts(text, emotesTag, target) {
    const chars = Array.from(text);
    const ranges = [];

    for (const chunk of (emotesTag || '').split('/')) {
      const colon = chunk.indexOf(':');
      if (colon === -1) continue;
      const id = chunk.slice(0, colon);
      for (const span of chunk.slice(colon + 1).split(',')) {
        const [s, e] = span.split('-').map(Number);
        if (Number.isFinite(s) && Number.isFinite(e)) ranges.push({ s, e, id });
      }
    }
    ranges.sort((a, b) => a.s - b.s);

    const parts = [];
    let i = 0;
    for (const r of ranges) {
      if (r.s < i || r.s >= chars.length) continue;
      if (r.s > i) parts.push({ t: 'text', v: chars.slice(i, r.s).join('') });
      const image = emoteImage(r.id, target);
      parts.push({ t: 'emote', v: image.url, alt: chars.slice(r.s, r.e + 1).join(''), h: image.h });
      i = r.e + 1;
    }
    if (i < chars.length) parts.push({ t: 'text', v: chars.slice(i).join('') });
    return parts;
  }

  // features: { badges, avatars } - which API data the overlay will display.
  // notice(text, seconds) shows a status line in the bar, e.g. a sign-in code.
  // target is read on every message, so resizing the source takes effect at
  // once; avatarPixels is a function for the same reason.
  function startTwitch({ config, features = {}, emotes, target, avatarPixels = () => 0, emit, notice, log }) {
    const channel = String(config.channel || '').toLowerCase().replace(/^#/, '');
    if (!channel) {
      log('no channel configured - skipping (edit config.js)');
      return { stop() {} };
    }

    let socket = null;
    let backoff = 1000;
    let stopped = false;
    let reconnectTimer = null;
    let refreshTimer = null;
    let watchdogTimer = null;
    let lastDataAt = 0;
    let probeSentAt = 0;
    let roomId = null;

    // ------------------------------------------------ optional API features

    let api = null;
    if (config.apiFeatures && (features.badges || features.avatars || features.cheermotes)) {
      if (!config.clientId) {
        log('apiFeatures needs twitch.clientId - badges, avatars and cheermotes off');
        notice?.('Twitch badges, avatars and cheermotes need twitch.clientId in config.js', 120);
      }
      else api = window.createTwitchApi({ clientId: config.clientId, notice, log });
    }
    const wantBadges = Boolean(api && features.badges);
    const wantAvatars = Boolean(api && features.avatars);
    const wantCheermotes = Boolean(api && features.cheermotes);

    // Twitch returns the 300x300 profile picture; AVATAR_SIZES also exist. A
    // size Twitch does not serve would 404, so the wish is snapped to one.
    const sizedAvatar = (url) => {
      const wish = Number(avatarPixels()) || 0;
      if (!url || !wish) return url ?? null;
      const size = AVATAR_SIZES.reduce((best, px) => (Math.abs(px - wish) < Math.abs(best - wish) ? px : best));
      return url.replace(/-profile_image-\d+x\d+/, `-profile_image-${size}x${size}`);
    };

    let badgeImages = null;           // "set/version" -> { url, title }
    const avatars = new Map();        // login -> url, or null when the user has none
    const avatarLookups = new Map();  // login -> pending Promise
    const queuedLogins = new Map();   // login -> resolve, not yet requested
    let avatarFlushTimer = null;

    async function loadBadges(id) {
      if (!wantBadges || !api.signedIn || !id) return;
      try {
        const [global, own] = await Promise.all([
          api.get('/chat/badges/global'),
          api.get(`/chat/badges?broadcaster_id=${encodeURIComponent(id)}`)
        ]);
        // Channel sets come last so they override global ones, e.g. subscriber badges.
        const images = {};
        for (const set of [...(global.data ?? []), ...(own.data ?? [])]) {
          for (const v of set.versions ?? []) {
            images[`${set.set_id}/${v.id}`] = { url: v.image_url_2x ?? v.image_url_1x, title: v.title ?? set.set_id };
          }
        }
        badgeImages = images;
        log(`${Object.keys(images).length} badge images`);
      } catch (err) {
        log(`badges unavailable (${err.message})`);
      }
    }

    function badgesFor(tag) {
      if (!badgeImages || !tag) return [];
      return tag.split(',')
        .filter((entry) => badgeImages[entry])
        .map((entry) => ({ ...badgeImages[entry], kind: BADGE_KINDS[entry.split('/')[0]] ?? 'event' }));
    }

    // Resolves to the sender's avatar URL or null. Logins requested within 150ms
    // are looked up together, up to 100 per request.
    function avatarFor(login) {
      if (!wantAvatars || !api.signedIn || !login) return Promise.resolve(null);
      if (avatars.has(login)) return Promise.resolve(avatars.get(login));
      if (!avatarLookups.has(login)) {
        avatarLookups.set(login, new Promise((resolve) => {
          queuedLogins.set(login, resolve);
          if (queuedLogins.size >= 100) flushAvatars();
          else if (!avatarFlushTimer) avatarFlushTimer = setTimeout(flushAvatars, 150);
        }));
      }
      return avatarLookups.get(login);
    }

    async function flushAvatars() {
      clearTimeout(avatarFlushTimer);
      avatarFlushTimer = null;
      const batch = [...queuedLogins].slice(0, 100);
      if (!batch.length) return;
      for (const [login] of batch) queuedLogins.delete(login);
      if (queuedLogins.size) avatarFlushTimer = setTimeout(flushAvatars, 0);

      let users = null;
      try {
        const query = batch.map(([login]) => `login=${encodeURIComponent(login)}`).join('&');
        users = {};
        for (const u of (await api.get(`/users?${query}`)).data ?? []) users[u.login] = sizedAvatar(u.profile_image_url);
      } catch (err) {
        users = null;
        log(`avatar lookup failed (${err.message})`);
      }
      for (const [login, resolve] of batch) {
        const url = users?.[login] ?? null;
        if (users) avatars.set(login, url);   // failed lookups are retried later
        avatarLookups.delete(login);
        resolve(url);
      }
      if (avatars.size > 5000) avatars.clear();
    }

    // Cheermote images per prefix, e.g. "cheer" for Cheer100, biggest tier first.
    let cheermotes = null;

    async function loadCheermotes(id) {
      if (!wantCheermotes || !api.signedIn || !id) return;
      try {
        const data = await api.get(`/bits/cheermotes?broadcaster_id=${encodeURIComponent(id)}`);
        const found = new Map();
        for (const action of data.data ?? []) {
          const tiers = (action.tiers ?? [])
            .map((tier) => ({
              bits: Number(tier.min_bits) || 0,
              url: tier.images?.dark?.animated?.['2'] ?? tier.images?.dark?.static?.['2']
            }))
            .filter((tier) => tier.url)
            .sort((a, b) => b.bits - a.bits);
          if (tiers.length) found.set(String(action.prefix).toLowerCase(), tiers);
        }
        cheermotes = found;
        log(`${found.size} cheermotes`);
      } catch (err) {
        log(`cheermotes unavailable (${err.message})`);
      }
    }

    // Replaces "Cheer100" with the matching cheermote image and the amount.
    function withCheermotes(parts) {
      if (!cheermotes) return parts;
      const out = [];
      for (const part of parts) {
        if (part.t !== 'text') {
          out.push(part);
          continue;
        }
        for (const token of part.v.split(/(\s+)/)) {
          const cheer = /^([a-zA-Z]+)(\d+)$/.exec(token);
          const tier = cheer && cheermotes.get(cheer[1].toLowerCase())?.find((t) => Number(cheer[2]) >= t.bits);
          if (tier) out.push({ t: 'emote', v: tier.url, alt: token }, { t: 'text', v: cheer[2] });
          else out.push({ t: 'text', v: token });
        }
      }
      return out;
    }

    function loadChannelData(id) {
      emotes?.loadChannel(id);
      loadBadges(id);
      loadCheermotes(id);
    }

    // Data requested before sign-in is loaded once it completes.
    api?.onReady(() => {
      loadBadges(roomId);
      loadCheermotes(roomId);
    });

    // Events leave in arrival order. A message may wait up to AVATAR_WAIT_MS for
    // its avatar, and later events wait behind it, so deletions stay in order.
    let outbox = Promise.resolve();
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function queueEvent(event, avatarLookup = null) {
      outbox = outbox
        .then(() => avatarLookup && Promise.race([avatarLookup, delay(AVATAR_WAIT_MS)]))
        .then((url) => {
          if (avatarLookup) event.avatar = url ?? null;
          emit(event);
        })
        .catch((err) => log(`event dropped (${err.message})`));
    }

    // ------------------------------------------------------------ connection

    const decorate = (parts) => (emotes ? emotes.decorate(parts) : parts);
    const send = (line) => {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(line);
    };

    function connect() {
      if (stopped) return;
      log(`connecting to #${channel}...`);
      socket = new WebSocket(IRC_URL);
      lastDataAt = Date.now();
      probeSentAt = 0;

      socket.onopen = () => {
        backoff = 1000;
        send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        send('PASS SCHMOOPIIE');
        send(`NICK justinfan${Math.floor(Math.random() * 80000 + 1000)}`);
        send(`JOIN #${channel}`);
        log(`connected to #${channel} (anonymous, read-only)`);
      };

      socket.onmessage = (event) => {
        lastDataAt = Date.now();
        probeSentAt = 0;
        for (const line of String(event.data).split('\r\n')) {
          if (line) handleLine(line);
        }
      };

      socket.onerror = () => log('socket error');

      socket.onclose = () => {
        if (stopped) return;
        log(`disconnected - retrying in ${Math.round(backoff / 1000)}s`);
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
    }

    function handleLine(line) {
      const { tags, prefix, command, params } = parseIRC(line);

      if (command === 'PING') return send(`PONG :${params[0] ?? 'tmi.twitch.tv'}`);
      if (command === 'RECONNECT') return socket?.close();

      // Sent after JOIN; room-id is the channel id the emote providers and the
      // Twitch API use.
      if (command === 'ROOMSTATE') {
        const id = tags['room-id'];
        if (id && id !== roomId) {
          roomId = id;
          loadChannelData(roomId);
          clearInterval(refreshTimer);
          refreshTimer = setInterval(() => loadChannelData(roomId), 60 * 60 * 1000);
        }
        return;
      }

      if (command === 'CLEARMSG') {
        return queueEvent({ type: 'delete', platform: 'twitch', id: tags['target-msg-id'] });
      }
      if (command === 'CLEARCHAT') {
        const target = tags['target-user-id'];
        return queueEvent(target
          ? { type: 'purge', platform: 'twitch', userId: target }
          : { type: 'clear', platform: 'twitch' });
      }
      if (command === 'USERNOTICE') return handleUserNotice(tags, params);
      if (command !== 'PRIVMSG') return;

      if (!roomId && tags['room-id']) {
        roomId = tags['room-id'];
        loadChannelData(roomId);
      }

      const login = prefix?.split('!')[0] ?? '';
      let text = params[1] ?? '';
      let isAction = false;
      if (text.startsWith('\u0001ACTION ') && text.endsWith('\u0001')) {
        isAction = true;
        text = text.slice(8, -1);   // emote offsets are relative to the stripped text
      }

      // A message made up entirely of blocked emotes has nothing left to show.
      let parts = decorate(buildParts(text, tags.emotes, target));
      if (tags.bits) parts = withCheermotes(parts);
      if (!parts.length) return;

      emitMessage({
        tags,
        login,
        name: tags['display-name'] || login,
        parts,
        rawText: text,
        isAction,
        highlight: tags['msg-id'] === 'highlighted-message'
      });
    }

    // Announcements are ordinary messages, highlighted. Subs, gifts and raids
    // are events: system-msg holds the wording, and the chatter may add a
    // message of their own.
    function handleUserNotice(tags, params) {
      const kind = tags['msg-id'] ?? '';
      const login = tags.login ?? '';
      const name = tags['display-name'] || login;
      const own = params[1] ?? '';

      if (kind === 'announcement') {
        const parts = decorate(buildParts(own, tags.emotes, target));
        if (parts.length) emitMessage({ tags, login, name, parts, rawText: own, highlight: true });
        return;
      }
      if (!EVENT_NOTICES.has(kind)) return;
      if (partOfGiftBomb(kind, tags, login)) return;

      // system-msg opens with the chatter's name, which the row shows already.
      const system = String(tags['system-msg'] ?? '').trim();
      let summary = system.startsWith(name) ? system.slice(name.length).trim() : system;
      // The raid wording carries the name in the middle instead.
      if (kind === 'raid') {
        const viewers = Number(tags['msg-param-viewerCount']) || 0;
        summary = viewers ? `raiding with ${viewers} viewers` : 'raiding';
      }

      const parts = [{ t: 'text', v: summary || kind }];
      if (own) parts.push({ t: 'text', v: ' - ' }, ...decorate(buildParts(own, tags.emotes, target)));

      emitMessage({
        tags,
        login,
        name,
        parts,
        rawText: own ? `${summary} ${own}` : summary,
        highlight: true,
        isEvent: true
      });
    }

    // Gift bombs by community-gift id when Twitch sends one, otherwise by the
    // gifter's login. The bomb row is shown; the recipients it announced are not.
    const giftBombs = new Map();

    function partOfGiftBomb(kind, tags, login) {
      const key = tags['msg-param-community-gift-id'] || login || '';
      if (!key) return false;
      const now = Date.now();

      if (kind === 'submysterygift') {
        giftBombs.set(key, { left: Number(tags['msg-param-mass-gift-count']) || 0, at: now });
        return false;
      }
      if (kind !== 'subgift' && kind !== 'anonsubgift') return false;

      const bomb = giftBombs.get(key);
      if (!bomb || now - bomb.at > GIFT_BOMB_MS || bomb.left <= 0) return false;
      bomb.left -= 1;
      if (bomb.left <= 0) giftBombs.delete(key);
      return true;
    }

    function emitMessage({ tags, login, name, parts, rawText, isAction = false, highlight = false, isEvent = false }) {
      queueEvent({
        type: 'message',
        platform: 'twitch',
        id: tags.id || `${Date.now()}-${Math.random()}`,
        userId: tags['user-id'] || login,
        displayName: name,
        color: tags.color || '',
        badges: badgesFor(tags.badges),
        avatar: null,
        parts,
        rawText,
        isAction,
        highlight,
        isEvent
      }, wantAvatars && api.signedIn ? avatarFor(login) : null);
    }

    // Catches connections that stay open but stop delivering, e.g. after sleep or
    // a network change; those may never fire onclose.
    function checkConnection() {
      if (stopped || !socket || socket.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (probeSentAt && now - probeSentAt > PROBE_TIMEOUT_MS) {
        log('connection silent - reconnecting');
        const dead = socket;
        dead.onopen = dead.onmessage = dead.onerror = dead.onclose = null;
        dead.close();
        connect();
      } else if (!probeSentAt && now - lastDataAt > IDLE_PROBE_MS) {
        probeSentAt = now;
        send('PING :tmi.twitch.tv');
      }
    }

    watchdogTimer = setInterval(checkConnection, 5000);
    connect();

    return {
      stop() {
        stopped = true;
        clearTimeout(reconnectTimer);
        clearInterval(watchdogTimer);
        clearTimeout(avatarFlushTimer);
        clearInterval(refreshTimer);
        api?.stop();
        socket?.close();
      }
    };
  }

  window.startTwitch = startTwitch;
})();
