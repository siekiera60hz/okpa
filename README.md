# PlatformSpoof

Spoofs your Discord gateway platform so others see a different client icon on your profile.

Available for **Vencord/Equicord**, **BetterDiscord**, and **Kettu Android** (mobile Vendetta-family plugin).


>**Warning:** This plugin modifies Discord's gateway connection to spoof your platform. This is not official Discord behavior and may violate their Terms of Service. Use at your own risk. The author is not responsible for any account restrictions.


## Platforms

| Option | Shows as |
|---|---|
| Off | your real client |
| Desktop (Windows) | Desktop: Online |
| Web / Browser | Web: Online |
| Mobile (Discord Android) | Mobile: Online |
| Meta Quest / VR | VR: Online |
| Console | Console: Online |

On Vencord/Equicord and BetterDiscord, changing the platform reconnects automatically. **Kettu Android:** a client restart can be required because Discord mobile may not expose a re-IDENTIFY API to plugins.

## Installation

**Vencord**
Drop `index.tsx` into `src/userplugins/PlatformSpoof/index.tsx` and rebuild (`pnpm build`).

**BetterDiscord**
Download The Latest build From [Releases](https://github.com/k1ng0p/PlatformSpoof/releases) and Drop `PlatformSpoof.plugin.js` into your BetterDiscord plugins folder:
- Windows: `%appdata%\BetterDiscord\plugins`
- Linux: `~/.config/BetterDiscord/plugins`
- Mac: `~/Library/Application Support/BetterDiscord/plugins`

Then enable it from the Plugins tab in Discord settings.

**Kettu Android**

1. Host the complete `kettu/` directory on an HTTPS static hosting service (for example GitHub Pages). Both `manifest.json` and `index.js` must be available at the same URL directory.
2. In Kettu, open **Settings → Plugins → +**, then paste the public **directory URL** (for example `https://USERNAME.github.io/PlatformSpoof/kettu/`) and install. A local ZIP is not an installation URL for Kettu.
3. Enable **PlatformSpoof (Kettu)**, open its settings, and choose Desktop, Web, Mobile, VR or Console. Restart the Kettu app if the icon does not change.

The Kettu build is standalone JavaScript in `kettu/index.js`, so no Vencord build or Node toolchain is required to deploy it. `kettu/manifest.json` contains the SHA-256 of that JavaScript. To test locally, run `node kettu/test.cjs`. If you edit `index.js`, recalculate the `hash` field before publishing.

**Compatibility note:** Kettu/Discord Mobile may transmit IDENTIFY using a native/binary transport rather than the standard JavaScript gateway method. In such builds the plugin cannot intercept IDENTIFY and its counter will stay at 0. This implementation is tested with mocked gateway WebSockets, but has **not** been verified on a real Kettu Android installation.


## How it works

Discord sends an IDENTIFY payload (op 2) to the gateway on every connection containing `os`, `browser`, and `device` fields. These determine the platform shown to others.

The plugin patches `socket.send()` to intercept every IDENTIFY before it's packed and sent, swapping those fields with the spoofed values. It also nulls `sessionId` before reconnecting to force a full IDENTIFY instead of a RESUME (RESUME doesn't re-send properties).

## Console helpers

Same on both versions:

```js
__ps.status()     // patch state, current platform, session info
__ps.reconnect()  // force re-IDENTIFY manually
__ps.sessions()   // check clientInfo on all active sessions
```

## Kettu implementation notes

The mobile build uses the Vendetta/Kettu `onLoad` / `onUnload` / `settings` lifecycle. It intercepts JSON `op: 2` IDENTIFY frames sent to `gateway.discord.gg` through React Native WebSocket and additionally hooks a discoverable `getSocket()` gateway wrapper, if available. It leaves every non-gateway WebSocket untouched. On unload it restores its hooks. Settings persist in the Kettu plugin storage. On platforms without a supported session reset/reconnect method, it advises a full app restart instead of forcing an unsafe RESUME-only reconnect.
