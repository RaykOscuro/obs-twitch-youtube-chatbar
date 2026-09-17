/* Optional Twitch API access for badges and avatars.
   Signs in with Twitch's device code flow: the bar shows a code that is entered
   once at twitch.tv/activate. No client secret is involved, so the Client ID of
   a public Twitch application is all the overlay needs. Tokens are kept in the
   browser source's storage and renewed automatically. */
(function () {
  const AUTH_URL = 'https://id.twitch.tv/oauth2';
  const HELIX_URL = 'https://api.twitch.tv/helix';
  const SCOPES = '';                    // badges and avatars are public data
  const NOTICE_SECONDS = 120;           // how long a sign-in code stays visible in the bar
  const VALIDATE_MS = 60 * 60 * 1000;   // Twitch requires validating tokens hourly

  function createTwitchApi({ clientId, notice = () => {}, log }) {
    const storageKey = `twitch-auth:${clientId}`;
    let auth = readStored();            // { accessToken, refreshToken } or null
    let ready = false;
    let stopped = false;
    let renewing = null;
    let validateTimer = null;
    const readyListeners = [];
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Storage can be unavailable; the sign-in then lasts until the source reloads.
    function readStored() {
      try { return JSON.parse(localStorage.getItem(storageKey)); } catch { return null; }
    }

    function store(value) {
      auth = value;
      try {
        if (value) localStorage.setItem(storageKey, JSON.stringify(value));
        else localStorage.removeItem(storageKey);
      } catch { /* kept in memory only */ }
    }

    async function authPost(path, params) {
      const res = await fetch(`${AUTH_URL}/${path}`, {
        method: 'POST',
        body: new URLSearchParams({ client_id: clientId, ...params })
      });
      return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
    }

    function setReady() {
      ready = true;
      log('signed in to Twitch');
      clearInterval(validateTimer);
      validateTimer = setInterval(async () => {
        if (!(await validate())) signedOut();
      }, VALIDATE_MS);
      for (const listener of readyListeners) listener();
    }

    function signedOut() {
      if (!ready) return;
      ready = false;
      clearInterval(validateTimer);
      store(null);
      log('Twitch sign-in expired - refresh the browser source to sign in again');
    }

    // Resolves true once a working token is in place, false when the sign-in is
    // gone. Throws on network and server errors, so a brief outage does not sign out.
    function renew(failedToken) {
      if (!renewing) {
        renewing = attemptRenew(failedToken).finally(() => { renewing = null; });
      }
      return renewing;
    }

    // Refresh tokens are single-use, and every copy of the overlay in OBS shares
    // this storage. If another copy renewed first, its token is adopted instead.
    async function attemptRenew(failedToken) {
      const stored = readStored();
      if (stored && stored.accessToken !== failedToken) { auth = stored; return true; }
      if (!auth?.refreshToken) return false;

      const { ok, status, data } = await authPost('token', {
        grant_type: 'refresh_token',
        refresh_token: auth.refreshToken
      });
      if (ok) {
        store({ accessToken: data.access_token, refreshToken: data.refresh_token });
        return true;
      }
      if (status >= 500) throw new Error(`token refresh -> ${status}`);

      const latest = readStored();
      if (latest && latest.accessToken !== failedToken) { auth = latest; return true; }
      return false;
    }

    // True while the token is usable. Network errors count as usable.
    async function validate() {
      if (!auth) return false;
      try {
        const token = auth.accessToken;
        const res = await fetch(`${AUTH_URL}/validate`, { headers: { Authorization: `OAuth ${token}` } });
        return res.status === 401 ? await renew(token) : true;
      } catch {
        return true;
      }
    }

    async function get(path) {
      if (!ready) throw new Error('not signed in to Twitch');
      const call = (token) => fetch(HELIX_URL + path, {
        headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` }
      });

      const token = auth.accessToken;
      let res = await call(token);
      if (res.status === 401) {
        if (!(await renew(token))) {
          signedOut();
          throw new Error('Twitch sign-in expired');
        }
        res = await call(auth.accessToken);
      }
      if (!res.ok) throw new Error(`helix ${path.split('?')[0]} -> ${res.status}`);
      return res.json();
    }

    async function signIn() {
      let device;
      try {
        const { ok, status, data } = await authPost('device', { scopes: SCOPES });
        if (!ok) throw new Error(data.message ?? `HTTP ${status}`);
        device = data;
      } catch (err) {
        log(`Twitch sign-in unavailable (${err.message})`);
        return;
      }

      const text = `Twitch badges and avatars: enter ${device.user_code} at twitch.tv/activate`;
      log(`${text} (valid for ${Math.round(device.expires_in / 60)} minutes)`);
      notice(text, NOTICE_SECONDS);

      const deadline = Date.now() + device.expires_in * 1000;
      let interval = (device.interval ?? 5) * 1000;

      while (Date.now() < deadline) {
        await sleep(interval);
        if (stopped) return;

        // Another copy of the overlay may have completed its own sign-in.
        const stored = readStored();
        if (stored) {
          auth = stored;
          notice(null);
          setReady();
          return;
        }

        let result;
        try {
          result = await authPost('token', {
            scopes: SCOPES,
            device_code: device.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          });
        } catch {
          continue;   // network error: try again next interval
        }

        if (result.ok) {
          store({ accessToken: result.data.access_token, refreshToken: result.data.refresh_token });
          notice(null);
          setReady();
          return;
        }
        if (result.data.message === 'slow_down') interval += 5000;
        else if (result.data.message !== 'authorization_pending') break;
      }

      notice(null);
      log('Twitch sign-in code expired - refresh the browser source for a new one');
    }

    (async () => {
      if (await validate()) setReady();
      else {
        store(null);
        signIn();
      }
    })();

    return {
      get,
      // Runs the listener after sign-in, or right away if already signed in.
      onReady(listener) {
        readyListeners.push(listener);
        if (ready) listener();
      },
      get signedIn() { return ready; },
      stop() {
        stopped = true;
        clearInterval(validateTimer);
      }
    };
  }

  window.createTwitchApi = createTwitchApi;
})();
