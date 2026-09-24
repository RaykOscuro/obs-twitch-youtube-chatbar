/* Overlay configuration. Edit, save, refresh the browser source in OBS.

   A plain script rather than JSON, so it also loads from a file:// URL.
   Everything except YouTube is fetched by the page itself. */
window.CHAT_CONFIG = {
  "twitch": {
    "enabled": true,
    // Login name, as in twitch.tv/<name>.
    "channel": "",
    // Twitch badges and avatars, shown with appearance.showBadges and showAvatar.
    // Needs a one-time sign-in: a code appears in the overlay, to be entered at
    // twitch.tv/activate.
    "apiFeatures": false,
    // Client ID of the public Twitch application used for that sign-in.
    // Public identifier, not a secret; replace it to use your own application.
    "clientId": "crzfws3otcf5jwqzjy6lp3y67963h4"
  },
  "youtube": {
    "enabled": false,
    // Channel handle (@name) or channel ID; resolves to its current live stream.
    "channel": "",
    // Set to use one specific broadcast instead of the channel's current one.
    "videoId": "",
    // Address of the relay that fetches YouTube chat: a Cloudflare Worker or
    // relay/server.mjs. See relay/README.md.
    "relayUrl": "",
    // Each poll returns up to ~10s of chat at once. true spaces the batch out
    // by each message's timestamp; false shows it immediately.
    "spreadBursts": true,
    // Seconds between checks while the stream has not started.
    "offlinePollSeconds": 20
  },
  "emotes": {
    // 7TV, BetterTTV and FrankerFaceZ: global sets plus the channel's own,
    // reloaded hourly. Applies to Twitch messages.
    "enabled": true,
    "sevenTv": true,
    "bttv": true,
    "ffz": true,
    // Case-insensitive substrings matched against emote names, not message
    // text. ["pepe"] also blocks "PepeLaugh".
    "blocklist": [],
    // "hide" removes a blocked emote, "text" shows its name instead. A message
    // made up only of blocked emotes is dropped.
    "blockedRender": "hide"
  },
  "filters": {
    // Drop messages starting with "!".
    "hideCommands": true,
    // Comma-separated display names to ignore, e.g. bots. Case-insensitive.
    "ignoredUsers": "",
    // Drop messages shorter than this many characters; 0 disables.
    "ignoreShorterThan": 0
  },
  "appearance": {
    // "bar" scrolls sideways, "list" stacks messages with the newest at the
    // bottom. "auto" takes the bar for sources at least twice as wide as tall.
    "layout": "auto",
    // Where new messages appear: "right" or "left" in the bar, "bottom" or
    // "top" in the list. "auto" uses right and bottom.
    "newestAt": "auto",
    // Hard cap on rows kept; trimOffscreen normally removes rows first.
    "messagesLimit": 50,
    // Seconds before a message is removed regardless of newer chat; 0 = never.
    "hideAfter": 0,
    "font": {
      "family": "Montserrat",
      // Stylesheet URL or font file (.woff2/.ttf); "" uses a system font.
      "url": "fonts/montserrat.css",
      "weight": "700",
      // Pixels, or "auto": in the bar the source height / 1.75, falling back to
      // 24 above 200px tall; in the list the source width / 20.
      "size": "auto"
    },
    "fontColor": "rgba(255,255,255,1)",
    "textShadow": "rgb(0, 0, 0) 1px 1px 1px",
    // Background; covers the whole browser source.
    "bgColor": "rgba(0, 0, 0, 0.2)",
    // Background of highlighted Twitch messages and YouTube Super Chats.
    "highlightColor": "#A400FF",
    // "user" = the chatter's own colour (generated where none is set),
    // "custom" = customNickColor, "messagecolor" = same as fontColor.
    "nickColor": "user",
    "customNickColor": "rgb(0, 255, 0)",
    // Text between name and message.
    "separator": ":",
    // false drops the name on consecutive messages from the same chatter and
    // shows continuationMarker instead. Bar only; the list always names them.
    "repeatNickname": false,
    "continuationMarker": "›",
    // Separator between messages: "none", "line" or "dot". Bar only.
    "messageDivider": {
      "style": "none",
      "color": "rgba(255,255,255,0.25)",
      "gap": 8
    },
    // For Twitch messages, these also need twitch.apiFeatures.
    "showBadges": false,
    "showAvatar": false,
    // Badge groups to show. Twitch sets not covered here, e.g. convention
    // badges, count as "event".
    "badgeKinds": {
      "role": true,         // broadcaster, moderator, VIP, staff
      "subscriber": true,   // channel subscribers and founders, YouTube members
      "channel": false,     // bits, gifting, hype train, predictions
      "account": false,     // Prime, Turbo
      "event": false        // Twitch events and charity drives
    },
    // Most badges per message, role badges first; 0 = no limit.
    "maxBadges": 2,
    "showPlatformIcon": true,
    // Twitch profile picture variant to request: 28, 50 or 70 pixels, snapped
    // to the nearest of those. 0 keeps the 300x300 one the API returns, which
    // the browser scales down.
    "avatarPixels": 0,
    // Pixels between the newest message and the edge it enters from.
    "paddingRight": 8,
    // Pixels over which messages fade out at the edge they leave by.
    "fadeLeft": 8,
    // "center", "top" or "bottom" within the source height.
    "verticalAlign": "center",
    "longMessages": {
      // Width cap for message text in the bar: a CSS length, or % of the
      // source width. The list wraps instead of capping.
      "maxWidth": "33%",
      // Width cap for the name; em scales with the font size.
      "maxNameWidth": "12em",
      // Longer names are shortened with an ellipsis; 0 disables.
      "maxNameChars": 15,
      // Times an over-long message scrolls through before it is truncated;
      // 0 truncates immediately.
      "scrollPasses": 2,
      // Pixels per second.
      "scrollSpeed": 25,
      // Upper limit for one pass in seconds; longer text scrolls faster.
      "maxPassSeconds": 12
    },
    // "slideInRight", "fadeIn", "bounceIn" or "none".
    "animationIn": "slideInRight",
    // "fadeOut", "slideOut", "bounceOut" or "none".
    "animationOut": "fadeOut",
    // Seconds.
    "animationDuration": 0.5,
    // Remove messages once they are fully past the far edge, which keeps the
    // source filled regardless of message length.
    "trimOffscreen": true,
    // Settings for one layout only; they override the ones above while that
    // layout is active, so one config can serve a bar in one scene and a list
    // in another. Example: "list": { "newestAt": "top", "hideAfter": 30 }
    "bar": {},
    "list": {}
  }
};
