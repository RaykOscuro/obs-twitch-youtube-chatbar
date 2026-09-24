# OBS Twitch + YouTube Chat Bar

A chat overlay for OBS that merges **Twitch** and **YouTube** live chat, with 7TV, BetterTTV and FrankerFaceZ emotes. It renders as a single-line ticker along an edge of the screen, or as a vertical list, depending on the shape of the browser source.

Plain HTML, CSS and JavaScript: no build step and no npm packages. Chat is read anonymously, without accounts or API keys; only the optional Twitch badges and avatars need a one-time sign-in.

## Features

- Twitch and YouTube in one place, as a sideways ticker or a vertical list
- The layout follows the source's shape, so resizing it in OBS switches between them
- 7TV, BetterTTV and FrankerFaceZ emotes (global sets plus the channel's own), with a name-based blocklist
- Long messages scroll through and then truncate in the bar, and wrap in the list
- In the bar, a chatter's next message drops the repeated name and shows a marker
- YouTube messages are replayed with their original timing instead of arriving in bursts
- Announcements, subs, gift subs and raids from Twitch, memberships, gifts and Super Stickers from YouTube, with gift bombs folded into one row
- Cheermote images for bits, when the Twitch API is signed in
- Moderator deletions, timeouts and bans remove messages from the overlay
- Old messages are trimmed once they leave the source, so it stays filled
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
   - **Width** and **Height**: the space the chat should fill, e.g. `1920` × `42` for a ticker along the bottom, or `400` × `800` for a list down the side. The shape picks the layout (see [Layout](#layout)) and the text size follows it (see [Sizing](#sizing))
   - Untick **Shutdown source when not visible**, so the bar keeps its history across scene changes

After editing `config.js`, refresh the browser source (right-click → *Refresh*).

### Previewing without live chat

Open the overlay in a regular browser with `?demo=1` added to the URL. It plays a scripted set of sample messages for checking the styling: a repeated sender, an emote, an over-long name and text, a Super Chat, an announcement, a sub, a raid, a cheer and a Super Sticker. The events obey `filters.showEvents`, so it also shows what that setting does.

## Twitch badges and avatars

Badge images and profile pictures come from the Twitch API, which needs a one-time sign-in. No password or token goes into the overlay:

1. In `config.js`, set `twitch.apiFeatures` to `true` and enable `appearance.showBadges` and/or `appearance.showAvatar`.
2. Refresh the browser source. For two minutes, the bar shows a code: *Twitch badges and avatars: enter ABCD-EFGH at twitch.tv/activate*. The console (F12) also logs it, with how long it stays valid.
3. Open <https://www.twitch.tv/activate> on any device, enter the code and approve. Badges and avatars appear within seconds.

By default only role and subscriber badges show, at most two per message. `appearance.badgeKinds` switches the groups on and off, and `appearance.maxBadges` caps how many appear. The groups are `role` (broadcaster, moderator, VIP, staff), `subscriber` (subscribers, founders, YouTube members), `channel` (bits, gifting, hype train, predictions), `account` (Prime, Turbo) and `event` (Twitch events and charity drives). With the platform icon and an avatar in front of the name as well, a message can otherwise carry five icons; `appearance.showPlatformIcon` and `appearance.showAvatar` turn those off.

Any Twitch account works; it does not need to be the channel's. The sign-in grants no permissions on the account and only lets the overlay read public data. Copies of the overlay in several scenes share it, so one code is enough. The sign-in is tied to the address the overlay is loaded from: switching between the local file and a local server's address, or changing that address, asks for a code again.

The sign-in is stored in OBS and renewed automatically. After 30 days without use, for example a long break from streaming, it expires, and the bar shows a new code the next time the overlay loads. To revoke access, disconnect it under *Twitch Settings → Connections*.

The approval page shows the name of the Twitch application the overlay signs in with, **OBS Chat Ticker Bar**. It differs from this project's name because Twitch does not allow "Twitch" in application names.

The overlay comes with that application's Client ID, so there is nothing to register. To use your own application instead, register one at <https://dev.twitch.tv/console/apps> with the client type **Public** and put its Client ID in `twitch.clientId`.

## Events and cheers

Besides chat, the overlay shows:

| Event | Platform | Shown as |
|---|---|---|
| Announcement | Twitch | The message itself, highlighted |
| Sub, resub, gift sub, raid | Twitch | A highlighted row with Twitch's own wording, plus the chatter's resub message if there is one |
| Super Chat, Super Sticker | YouTube | The amount, the message or the sticker image, highlighted |
| Membership, gifted memberships | YouTube | A highlighted row |

A community gift sub sends one bomb notice plus one per recipient, so the recipients are folded into the bomb for 30 seconds. A 20-sub bomb is one row, not 21.

`filters.showEvents: false` hides the rows that are not chat: subs, gift subs, raids, memberships and gifts. Announcements, Super Chats and Super Stickers stay, since each carries something a viewer sent.

Bits become cheermote images, so `Cheer100` renders as the animated cheermote with the amount next to it. That needs the Twitch sign-in (`twitch.apiFeatures`); without it the text is left alone, and `emotes.cheermotes: false` turns it off.

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
| `filters` | Hiding `!commands`, ignored users, minimum message length, events |
| `appearance` | Layout and direction, font, colours, badges and avatars, animations, long-message behaviour, trimming |

The file is JavaScript, not JSON: keep quotes and commas intact when editing. A typo stops the whole overlay; opening it in a regular browser shows the error in the console (F12).

## Layout

`appearance.layout` picks how messages are arranged:

| Value | Result |
|---|---|
| `"auto"` (default) | The bar when the source is at least twice as wide as it is tall, the list otherwise |
| `"bar"` | Always the sideways ticker |
| `"list"` | Always the vertical list |

In the **bar**, the newest message sits on the right, older ones move left and leave at the left edge, and over-long messages scroll through before they are truncated.

In the **list**, the newest message sits at the bottom, long messages wrap under the name, and older ones leave at the top edge. `animationIn: "slideInRight"` slides new messages up instead.

`appearance.newestAt` flips the direction: `"left"` in the bar, `"top"` in the list. `"auto"` keeps right and bottom. The fade, the padding and the slide animation follow the edge that messages enter from.

Every browser source reads the same `config.js`, so settings that should differ per layout go in `appearance.bar` and `appearance.list`. They override the shared ones while that layout is active:

```js
"appearance": {
  "newestAt": "auto",
  "hideAfter": 0,
  "bar":  { "maxBadges": 1 },
  "list": { "newestAt": "top", "hideAfter": 30, "font": { "size": 18 } }
}
```

A bar source and a list source can then run side by side from one file. Objects such as `font` are merged key by key, so the example above keeps the shared font family and only changes the size.

Badges and avatars are fetched when either layout asks for them, so a source that flips layouts keeps working; what is drawn still follows the layout in force.

`repeatNickname: false` applies to the bar only, where consecutive messages from one chatter drop the name and show `continuationMarker` instead. The list has room for the name, so it repeats it on every message.

Everything else works the same in both: emotes, badges, avatars, filters and moderator deletions.

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

In the list, `"auto"` divides the source width by 20 instead, between 14px and 32px: 15px in a 300px-wide panel, 20px in a 400px one. A number set in `font.size` overrides this in either layout.

## Troubleshooting

**Nothing appears.** Open the overlay in a regular browser and check the developer console (F12); every connection and message is logged there. `?demo=1` confirms that rendering works independently of the chat sources.

**Twitch works, YouTube doesn't.** Open `<relayUrl>/diag?channel=@name` in a browser. `channel is not live right now` is expected before the stream starts; the overlay re-checks every 20 seconds.

**Emotes missing.** Look for `unavailable` lines from 7TV, BetterTTV or FrankerFaceZ in the console. Each provider loads independently.

**Emotes or text look blurry.** Compare the browser source's own width and height with its size on the canvas (*Transform → Edit Transform*: *Size* should match, at scale 1.000). Anything else makes OBS rescale the whole source. Emote files are picked to match the text size, so they usually render unscaled. Twitch profile pictures arrive at 300×300 and are scaled down by the browser; `appearance.avatarPixels` (28, 50 or 70) requests a smaller file instead.

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
