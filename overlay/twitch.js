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

  // Splits text into text and emote parts using the IRC emotes tag. Its ranges
  // count code points, not UTF-16 units, hence Array.from: string indices would
  // misplace every emote after an emoji.
  function buildParts(text, emotesTag) {
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
      parts.push({
        t: 'emote',
        v: `https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/2.0`,
        alt: chars.slice(r.s, r.e + 1).join('')
      });
      i = r.e + 1;
    }
    if (i < chars.length) parts.push({ t: 'text', v: chars.slice(i).join('') });
    return parts;
  }

  // features: { badges, avatars } - which API data the overlay will display.
  // notice(text, seconds) shows a status line in the bar, e.g. a sign-in code.
  function startTwitch({ config, features = {}, emotes, emit, notice, log }) {
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
    if (config.apiFeatures && (features.badges || features.avatars)) {
      if (!config.clientId) {
        log('apiFeatures needs twitch.clientId - badges and avatars off');
        notice?.('Twitch badges and avatars need twitch.clientId in config.js', 120);
      }
      else api = window.createTwitchApi({ clientId: config.clientId, notice, log });
    }
    const wantBadges = Boolean(api && features.badges);
    const wantAvatars = Boolean(api && features.avatars);

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
      return tag.split(',').map((entry) => badgeImages[entry]).filter(Boolean);
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
        for (const u of (await api.get(`/users?${query}`)).data ?? []) users[u.login] = u.profile_image_url ?? null;
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

    function loadChannelData(id) {
      emotes?.loadChannel(id);
      loadBadges(id);
    }

    // Badges requested before sign-in are loaded once it completes.
    api?.onReady(() => loadBadges(roomId));

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
      const parts = decorate(buildParts(text, tags.emotes));
      if (!parts.length) return;

      queueEvent({
        type: 'message',
        platform: 'twitch',
        id: tags.id || `${Date.now()}-${Math.random()}`,
        userId: tags['user-id'] || login,
        displayName: tags['display-name'] || login,
        color: tags.color || '',
        badges: badgesFor(tags.badges),
        avatar: null,
        parts,
        rawText: text,
        isAction,
        highlight: tags['msg-id'] === 'highlighted-message'
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
