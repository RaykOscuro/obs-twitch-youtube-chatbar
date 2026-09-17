/* Overlay configuration. Edit, save, refresh the browser source in OBS.

   A plain script rather than JSON, so it also loads from a file:// URL.
   Everything except YouTube is fetched by the page itself. */
window.CHAT_CONFIG = {
  "twitch": {
    "enabled": true,
    // Login name, as in twitch.tv/<name>.
    "channel": "",
    // Twitch badges and avatars, shown with appearance.showBadges and showAvatar.
    // Needs a one-time sign-in: the bar shows a code to enter at twitch.tv/activate.
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
    // Hard cap on rows kept; trimOffscreen normally removes rows first.
    "messagesLimit": 50,
    // Seconds before a message is removed regardless of newer chat; 0 = never.
    "hideAfter": 0,
    "font": {
      "family": "Montserrat",
      // Stylesheet URL or font file (.woff2/.ttf); "" uses a system font.
      "url": "fonts/montserrat.css",
      "weight": "700",
      // Pixels, or "auto": source height / 1.75 for sources up to 200px tall,
      // otherwise 24.
      "size": "auto"
    },
    "fontColor": "rgba(255,255,255,1)",
    "textShadow": "rgb(0, 0, 0) 1px 1px 1px",
    // Bar background; covers the whole browser source.
    "bgColor": "rgba(0, 0, 0, 0.2)",
    // Background of highlighted Twitch messages and YouTube Super Chats.
    "highlightColor": "#A400FF",
    // "user" = the chatter's own colour (generated where none is set),
    // "custom" = customNickColor, "messagecolor" = same as fontColor.
    "nickColor": "user",
    "customNickColor": "rgb(0, 255, 0)",
    // Text between name and message.
    "separator": ":",
    // false replaces the name on consecutive messages from the same chatter
    // with continuationMarker.
    "repeatNickname": false,
    "continuationMarker": "›",
    // Separator between messages: "none", "line" or "dot".
    "messageDivider": {
      "style": "none",
      "color": "rgba(255,255,255,0.25)",
      "gap": 8
    },
    // For Twitch messages, these also need twitch.apiFeatures.
    "showBadges": false,
    "showAvatar": false,
    "showPlatformIcon": true,
    // Pixels between the newest message and the right edge.
    "paddingRight": 8,
    // Pixels over which messages fade out at the left edge.
    "fadeLeft": 8,
    // "center", "top" or "bottom" within the source height.
    "verticalAlign": "center",
    "longMessages": {
      // Width cap for message text: a CSS length, or % of the bar width.
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
    // Remove messages once they are fully past the left edge, which keeps the
    // bar full regardless of message length.
    "trimOffscreen": true
  }
};
