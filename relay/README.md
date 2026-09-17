# YouTube chat relay

A browser source cannot read YouTube's live chat directly, because the endpoint sends no CORS headers. `relay.js` fetches the chat and hands the messages to the overlay.

The same `relay.js` runs in two ways:

- **[Cloudflare Worker](#option-a-cloudflare-worker)**: deployed once on the free plan; nothing runs locally
- **[Local server](#option-b-local-server)**: `server.mjs` runs it with Node.js and can also host the overlay

## Choosing

| | Cloudflare Worker | Local server |
|---|---|---|
| Runs locally | Nothing | A Node.js process |
| Account needed | Cloudflare | None |
| YouTube sees | A datacenter IP | The home connection |
| Can host the overlay | No | Yes |

YouTube sometimes answers requests from datacenters such as Cloudflare's with `403` errors or incomplete pages. The relay retries and works around this, but a local server on a home connection avoids it altogether.

## Option A: Cloudflare Worker

### Dashboard

1. Sign in at <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Create Worker**.
2. Choose a name, e.g. `obs-twitch-youtube-chatbar`, and deploy the placeholder.
3. Select **Edit code**, replace the placeholder with the contents of `relay.js`, then **Deploy**.
4. Copy the Worker's URL into `overlay/config.js`:

   ```js
   "relayUrl": "https://obs-twitch-youtube-chatbar.<subdomain>.workers.dev"
   ```

### Wrangler

`wrangler.toml` is included:

```sh
cd relay
npx wrangler login
npx wrangler deploy
```

### Cost

The free plan allows 100,000 requests per day. The overlay polls at the interval YouTube asks for, typically every 5 to 10 seconds, which is about 2,900 to 5,800 requests for an 8-hour stream. While waiting for a stream to start, it checks once every 20 seconds.

## Option B: Local server

Requires Node.js 18 or newer. There is nothing to install.

From the repository folder:

```sh
node relay/server.mjs
```

This starts the server on port 8788, reachable from other machines on the network. Optional arguments change that:

| Command | Effect |
|---|---|
| `node relay/server.mjs 9000` | Use port 9000 instead |
| `node relay/server.mjs 8788 127.0.0.1` | Accept connections from this machine only |

In `overlay/config.js`, set `youtube.relayUrl` to the server's address, e.g. `"relayUrl": "http://localhost:8788"`.

The server can also host the `overlay/` folder at the same address. With the server on another machine, OBS can then load the overlay from it (e.g. `http://raspberrypi.local:8788/`), so the streaming PC needs no copy and `config.js` is edited in one place. Loading the overlay as a local file is more robust, though: if the server is down when OBS loads the page, a hosted overlay stays empty, while a local file still shows Twitch chat. With Twitch badges and avatars enabled, switching between the two asks for a new sign-in code.

To avoid starting it by hand, set it to start automatically.

### Autostart on Windows

From the repository folder, on the machine that should run the relay:

```powershell
powershell -ExecutionPolicy Bypass -File .\relay\autostart-windows.ps1
Start-ScheduledTask -TaskName obs-twitch-youtube-chatbar    # start now instead of at next logon
```

This registers a scheduled task that starts the server at logon. It runs through `start-hidden.vbs`, which keeps the console window hidden.

| Command | Effect |
|---|---|
| `.\relay\autostart-windows.ps1` | Start hidden at logon |
| `.\relay\autostart-windows.ps1 -Port 9000` | Use another port |
| `.\relay\autostart-windows.ps1 -Supervised` | Start at boot as SYSTEM and restart on failure (needs an elevated shell) |
| `.\relay\autostart-windows.ps1 -Uninstall` | Remove the task |

The default task launches the server and exits, so Task Scheduler cannot restart it if Node stops. `-Supervised` covers that, at the cost of running with elevated privileges.

### Autostart on Linux

For example on a Raspberry Pi or a home server:

1. Install Node.js 18 or newer. On a Raspberry Pi, a 64-bit OS has the best support in current Node releases.
2. Copy `obs-twitch-youtube-chatbar.service` to `/etc/systemd/system/` and set the user and paths in it.
3. Enable and start it:

   ```sh
   sudo systemctl enable --now obs-twitch-youtube-chatbar
   journalctl -u obs-twitch-youtube-chatbar -f      # follow the log
   ```

On the streaming PC, set `youtube.relayUrl` to that machine's address, e.g. `http://raspberrypi.local:8788`. If `.local` names do not resolve, use its IP address and reserve it in the router.

## Endpoints

The overlay calls these itself. `/open` and `/diag` can also be opened in a browser for troubleshooting.

| Route | Purpose |
|---|---|
| `GET /open?channel=@handle` | Find the channel's live broadcast and open a chat session |
| `GET /open?videoId=ID` | Same, for a specific video |
| `POST /poll` | Fetch new messages for an open chat session |
| `GET /diag?channel=@handle` | Diagnostics: what YouTube returned to the relay and which candidate videos have a live chat |

Errors are returned as `{"error": "..."}` with a 4xx or 5xx status. `channel is not live right now` is the normal response before a stream starts.

## Security and privacy

- The relay holds no credentials. It only reads public chat and stores none of it.
- The `apiKey` in responses is YouTube's public web client key, the same for every visitor, not a secret.
- A deployed Worker URL is public. Anyone who finds it can read public chat through it, which counts against the same daily request allowance.
- The local server listens on all network interfaces by default, so other machines on the network can reach it. Pass `127.0.0.1` as the host argument to restrict it to the local machine.