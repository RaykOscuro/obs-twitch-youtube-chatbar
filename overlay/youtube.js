/* YouTube live chat via the relay at youtube.relayUrl (see relay/README.md).
   The relay is stateless; this client holds the continuation token and sends
   it with every poll. */
(function () {
  function startYouTube({ config, emit, log }) {
    const base = String(config.relayUrl || '').replace(/\/+$/, '');
    if (!base) {
      log('no relayUrl configured - skipping (see relay/README.md)');
      return { stop() {} };
    }

    let stopped = false;
    let timer = null;
    // Only the first session skips the backlog. On reconnect it holds messages
    // missed during the gap, and `seen` removes repeats.
    let everPrimed = false;
    const seen = new Set();
    const sleep = (ms) => new Promise((resolve) => { timer = setTimeout(resolve, ms); });

    // Messages scheduled for release, so deletions can still cancel them.
    const waiting = new Map();   // message id -> timer

    function cancelWaiting(matches) {
      for (const [id, entry] of waiting) {
        if (!matches(entry.message)) continue;
        clearTimeout(entry.timer);
        waiting.delete(id);
      }
    }

    // Emits a batch. With spreadBursts, messages are spaced by their send
    // timestamps, compressed to finish before the next poll.
    function release(events, windowMs) {
      if (config.spreadBursts === false) { events.forEach(emit); return; }

      const messages = events.filter((e) => e.type === 'message' && e.ts);
      const rest = events.filter((e) => !(e.type === 'message' && e.ts));

      const first = messages.length ? Math.min(...messages.map((m) => m.ts)) : 0;
      const last = messages.length ? Math.max(...messages.map((m) => m.ts)) : 0;
      const span = last - first;
      // Leave a margin so the tail of one batch never collides with the next.
      const replay = Math.min(span, Math.max(windowMs - 1500, 0));

      // Timestamps can be slightly out of order; delays never decrease, so the
      // order YouTube sent is kept.
      let previous = 0;
      for (const message of messages) {
        const scaled = span > 0 ? ((message.ts - first) / span) * replay : 0;
        const delay = Math.max(scaled, previous);
        previous = delay;

        if (delay < 30) { emit(message); continue; }
        const timer = setTimeout(() => {
          waiting.delete(message.id);
          emit(message);
        }, delay);
        waiting.set(message.id, { timer, message });
      }

      // Handled after scheduling, so a deletion can cancel a pending message.
      for (const event of rest) {
        if (event.type === 'delete') cancelWaiting((m) => m.id === event.id);
        if (event.type === 'purge') cancelWaiting((m) => m.userId === event.userId);
        if (event.type === 'clear') cancelWaiting(() => true);
        emit(event);
      }
    }

    async function open() {
      const params = config.videoId
        ? `videoId=${encodeURIComponent(config.videoId)}`
        : `channel=${encodeURIComponent(config.channel ?? '')}`;
      const res = await fetch(`${base}/open?${params}`, { cache: 'no-store' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      log(`live video ${data.videoId} - streaming chat`);
      if (data.filtered) log('warning: only the filtered "Top chat" feed was available');
      const priming = !everPrimed;
      everPrimed = true;
      return { ...data, priming };
    }

    async function poll(state) {
      // text/plain avoids a CORS preflight on every poll.
      const res = await fetch(`${base}/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({
          apiKey: state.apiKey,
          clientVersion: state.clientVersion,
          continuation: state.continuation
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const fresh = [];
      for (const event of data.messages ?? []) {
        if (event.type !== 'message') { fresh.push(event); continue; }
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        // The first response is the backlog; record it without showing it.
        if (!state.priming) fresh.push(event);
      }
      state.priming = false;
      if (seen.size > 5000) seen.clear();

      const wait = data.timeoutMs ?? 5000;
      release(fresh, wait);

      state.continuation = data.continuation;
      return wait;
    }

    async function run() {
      let state = null;
      let retry = 5000;
      let failures = 0;

      while (!stopped) {
        try {
          if (!state) { state = await open(); retry = 5000; }
          await sleep(await poll(state));
          failures = 0;
        } catch (err) {
          if (stopped) return;
          failures++;

          // Retry the same poll a few times before reopening the session.
          if (state && failures < 3) {
            log(`${err.message} - retrying poll`);
            await sleep(1500);
            continue;
          }

          state = null;
          failures = 0;

          // Waiting for a stream to start is expected, so poll at a steady
          // interval instead of backing off.
          const notLiveYet = /not live/i.test(err.message);
          const wait = notLiveYet ? (config.offlinePollSeconds ?? 20) * 1000 : retry;
          if (!notLiveYet) retry = Math.min(retry * 2, 120000);

          log(`${err.message} - checking again in ${Math.round(wait / 1000)}s`);
          await sleep(wait);
        }
      }
    }

    run();

    return {
      stop() {
        stopped = true;
        clearTimeout(timer);
        for (const entry of waiting.values()) clearTimeout(entry.timer);
        waiting.clear();
      }
    };
  }

  window.startYouTube = startYouTube;
})();
