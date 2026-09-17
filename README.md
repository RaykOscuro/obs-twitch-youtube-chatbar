# OBS Twitch + YouTube Chat Bar

A single-line, horizontal chat ticker for OBS that merges **Twitch** and **YouTube** live chat into one bar, with 7TV, BetterTTV and FrankerFaceZ emotes.

Plain HTML, CSS and JavaScript: no build step and no npm packages. Chat is read anonymously, without accounts or API keys; only the optional Twitch badges and avatars need a one-time sign-in.

## Features

- Twitch and YouTube in one bar, newest message on the right, older ones leaving on the left
- 7TV, BetterTTV and FrankerFaceZ emotes (global sets plus the channel's own), with a name-based blocklist
- Long messages are capped in width, scrolled through, then truncated with an ellipsis
- Consecutive messages from one chatter share a single name, separated by a marker
- YouTube messages are replayed with their original timing instead of arriving in bursts
- Moderator deletions, timeouts and bans remove messages from the bar
- Trimming by width keeps the bar full whether messages are short or long
- Optional Twitch badges and profile pictures after a one-time sign-in with a code
- Bundled font; nothing is loaded from font or stylesheet CDNs

## How it works

```
OBS browser source (overlay/)
├── Twitch chat    WebSocket ─────────────────► irc-ws.chat.twitch.tv  (anonymous, read-only)
├── Twitch extras  fetch ─────────────────────► api.twitch.tv          (optional: badges, avatars)
├── Emotes         fetch ─────────────────────► 7TV · BetterTTV · FrankerFaceZ
└── YouTube chat   fetch ──► relay (relay/) ──► youtube.com
```

Everything except YouTube runs inside the browser source. YouTube's live chat endpoint sends no CORS headers, so a web page cannot read it directly; the small relay in `relay/` fetches it and passes the messages on. It is the same file whether it runs as a Cloudflare Worker or as a local Node.js server.

Twitch-only setups need no relay at all.

## Quick start

1. **Configure.** Open `overlay/config.js` and set `twitch.channel` to the Twitch login name. Every option is documented in the file.
2. **Add YouTube (optional).** Set up the relay as described in [relay/README.md](relay/README.md), then in `config.js` set `youtube.enabled` to `true`, `youtube.channel` to the channel handle (`@name`) and `youtube.relayUrl` to the relay's address.
3. **Add Twitch badges and avatars (optional).** See [Twitch badges and avatars](#twitch-badges-and-avatars).
4. **Add to OBS.** *Sources → + → Browser*:
   - Tick **Local file** and select `overlay/index.html`. A local file keeps Twitch chat working even when the relay is down. Typing a `file:///` URL instead also works, but spaces in the path must then be written as `%20`.
   - **Width**: the canvas width, e.g. `1920`
   - **Height**: the bar height, e.g. `42`; the text size follows it (see [Sizing](#sizing))
   - Untick **Shutdown source when not visible**, so the bar keeps its history across scene changes

After editing `config.js`, refresh the browser source (right-click → *Refresh*).

### Previewing without live chat

Open the overlay in a regular browser with `?demo=1` added to the URL. It plays a scripted set of sample messages (a repeated sender, an emote, a highlighted message, an over-long name and text) for checking the styling.

## Twitch badges and avatars

Badge images and profile pictures come from the Twitch API, which needs a one-time sign-in. No password or token goes into the overlay:

1. In `config.js`, set `twitch.apiFeatures` to `true` and enable `appearance.showBadges` and/or `appearance.showAvatar`.
2. Refresh the browser source. For two minutes, the bar shows a code: *Twitch badges and avatars: enter ABCD-EFGH at twitch.tv/activate*. The console (F12) also logs it, with how long it stays valid.
3. Open <https://www.twitch.tv/activate> on any device, enter the code and approve. Badges and avatars appear within seconds.

Any Twitch account works; it does not need to be the channel's. The sign-in grants no permissions on the account and only lets the overlay read public data. Copies of the overlay in several scenes share it, so one code is enough. The sign-in is tied to the address the overlay is loaded from: switching between the local file and a local server's address, or changing that address, asks for a code again.

The sign-in is stored in OBS and renewed automatically. After 30 days without use, for example a long break from streaming, it expires, and the bar shows a new code the next time the overlay loads. To revoke access, disconnect it under *Twitch Settings → Connections*.

The approval page shows the name of the Twitch application the overlay signs in with, **OBS Chat Ticker Bar**. It differs from this project's name because Twitch does not allow "Twitch" in application names.

The overlay comes with that application's Client ID, so there is nothing to register. To use your own application instead, register one at <https://dev.twitch.tv/console/apps> with the client type **Public** and put its Client ID in `twitch.clientId`.

## Relay options

- **Cloudflare Worker**: deployed once on the free plan, nothing runs locally.
- **Local server**: `relay/server.mjs` on the streaming PC or any always-on machine, with autostart scripts for Windows and Linux. It can also host the overlay for OBS, though a local file is more robust (see [relay/README.md](relay/README.md#option-b-local-server)).

YouTube sometimes answers requests from datacenters such as Cloudflare's with `403` errors or incomplete pages. The relay retries and works around this, but a local server on a home connection avoids it altogether. Setup and a comparison are in [relay/README.md](relay/README.md).

## Configuration

All settings live in `overlay/config.js`, grouped as:

| Section | Controls |
|---|---|
| `twitch` | Channel, on/off, optional badges and avatars |
| `youtube` | Channel or pinned video, relay address, burst pacing, offline re-check interval |
| `emotes` | Which providers load, blocklist, how blocked emotes render |
| `filters` | Hiding `!commands`, ignored users, minimum message length |
| `appearance` | Font, colours, sizing, animations, long-message behaviour, trimming |

The file is JavaScript, not JSON: keep quotes and commas intact when editing. A typo stops the whole overlay; opening it in a regular browser shows the error in the console (F12).

## Sizing

The bar fills the browser source exactly, so the source height is the bar height. By default, `appearance.font.size` is `"auto"`: the text size is the source height divided by 1.75, rounded, which leaves room for emotes at 1.3 times the font size. Resizing the source in OBS resizes the text with it. This applies to sources up to 200px tall; taller ones, such as a full-canvas source cropped in OBS or the overlay opened in a regular browser, use 24px.

To choose the size yourself, set `font.size` to a number of pixels and match the source height to it:

| Font size | Minimum height | Comfortable |
|---|---|---|
| 20 | 30 | 36 |
| 24 | 36 | 42 |
| 28 | 42 | 50 |
| 32 | 48 | 56 |

Below the minimum, emotes are clipped. Above it, the text sits centred in a taller background band (see `appearance.verticalAlign`).

## Troubleshooting

**Nothing appears.** Open the overlay in a regular browser and check the developer console (F12); every connection and message is logged there. `?demo=1` confirms that rendering works independently of the chat sources.

**Twitch works, YouTube doesn't.** Open `<relayUrl>/diag?channel=@name` in a browser. `channel is not live right now` is expected before the stream starts; the overlay re-checks every 20 seconds.

**Emotes missing.** Look for `unavailable` lines from 7TV, BetterTTV or FrankerFaceZ in the console. Each provider loads independently.

**No Twitch badges or avatars.** Check the console for `[twitch]` lines. If the sign-in code expired or the sign-in was revoked, refresh the browser source to get a new code.

## Limitations

- YouTube chat is read through YouTube's undocumented internal API. It needs no key and has no quota, but YouTube can change it without notice, which would stop YouTube chat until the relay is updated (for a Worker, by deploying the new `relay/relay.js`). Twitch chat is not affected.
- Twitch badges and profile pictures need the one-time sign-in described above. YouTube badges and avatars need none.
- With Twitch avatars enabled, a chatter's first message waits for the avatar lookup, at most 1.5 seconds. Later messages use the cached result.
- Third-party emotes apply to Twitch messages. YouTube's own channel emoji already arrive as images.

## Credits

Bundled font: [Montserrat](https://github.com/JulietaUla/Montserrat), licensed under the SIL Open Font License 1.1 (see `overlay/fonts/OFL.txt`).

Not affiliated with Twitch, YouTube, 7TV, BetterTTV, FrankerFaceZ, OBS or Cloudflare.

## Support

If you find this useful, you can support its development on [Ko-fi](https://ko-fi.com/raykoscuro).

## License

The code is licensed under the GNU General Public License, version 2 or (at your option) any later version; the full text is in [LICENSE](LICENSE). It is provided "as is", without warranty of any kind.

The Montserrat font files in `overlay/fonts/` are not covered by the GPL. They remain under the SIL Open Font License 1.1 (see `overlay/fonts/OFL.txt`).
