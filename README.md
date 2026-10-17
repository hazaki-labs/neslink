# NESLink

A platform for playing NES games in the browser, built toward multiplayer netplay (input sync + rollback).

Current milestone: **M2 rollback netplay + spectating**.

- **Single player**: load a local `.nes` file and play, with quick save/load. ROMs and saves live only in the browser's IndexedDB and are never uploaded.
- **Netplay**: click **Netplay** on a game in the library to create a room, then share the room link. Everyone who joins loads their own copy of the same ROM (checked by SHA-1). The host takes 1P automatically; others join as spectators and can click **Sit** to take a free seat. The host can start once at least one person is seated (in a solo game everyone else watches). Seated players run from power-on, exchanging only their controller input for each frame, with **rollback**: your own input takes effect after a small delay (1–4 frames, picked from both players' measured latency), and the other player's input is predicted until it arrives. When a prediction turns out wrong, the game reloads the state from before that frame and silently re-simulates up to the present, so neither player waits on the network. Players never run more than a few frames ahead of what is confirmed (the window is sized to what the device can re-simulate in ~12 ms), the side that runs ahead yields a frame now and then, and a work-RAM hash of confirmed frames is compared every 60 frames to detect desyncs.
- **Languages**: the UI is in English and Chinese. It follows the browser language on the first visit, and can be switched (and is remembered) from the library page.
- **Direct connection**: once both players are seated, the browsers also try a WebRTC data channel straight to each other (signaled through the room, public STUN only). Inputs then travel peer to peer, skipping the server, over an unordered, no-retransmit channel where every packet repeats all unacknowledged inputs, so lost packets cost nothing. Inputs still go through the server too (spectators and snapshots rely on it); whichever copy arrives first wins, so if a direct link can't be made, play simply stays on the server. When both players are linked directly, the input delay is picked from the direct latency, often 1 frame.
- **Spectating**: anyone with the link can watch, even mid-game. The lowest-seated player uploads a save-state snapshot to the room every 600 frames (~10 s); a spectator joining mid-game starts from the latest snapshot and fast-forwards (muted) to live. Spectators only ever see confirmed inputs, never predictions.

## Layout

```
apps/web           Vite + React frontend (library, player, room lobby); builds to static files.
                   UI copy lives in typed dictionaries in apps/web/src/i18n/messages.tsx
apps/server        Cloudflare Worker: serves the built frontend and /api; one Durable Object per room
                   handles seating, relays inputs and compares hashes
packages/core      Emulator core interface, WASM core adapter, input mapping, frame pacing,
                   worker message protocol, netplay protocol, rollback and lockstep sessions
packages/nes-wasm  Rust wrapper: tetanes-core compiled to WebAssembly (wasm-bindgen)
```

The emulator runs in a Web Worker (`apps/web/src/lib/emulator/emulator.worker.ts`), draws straight to an OffscreenCanvas, and streams audio directly to an AudioWorklet (`apps/web/public/audio-worklet.js`).

## Development

The compiled WASM in `packages/nes-wasm/pkg` is checked in, so frontend-only work does not need Rust. After changing the Rust code, rebuild it; this needs stable Rust, the `wasm32-unknown-unknown` target, and a `wasm-bindgen-cli` matching the wasm-bindgen version in `Cargo.lock`:

```bash
pnpm build:wasm
```

To try netplay at a given latency on one machine, add `?lag=150&jitter=30` (milliseconds) to a room URL: that tab's server connection gets that much extra round trip and random jitter (the latency readout includes it). Add `?p2p=0` to keep a tab off the direct link, to compare.

```bash
pnpm install
pnpm dev         # Vite (http://localhost:5173) plus wrangler dev (:8787, /api proxied through Vite)
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

## Deploying (Cloudflare)

The frontend and the netplay service deploy as a single Worker (`apps/server/wrangler.jsonc`). Log in to Cloudflare once before the first deploy:

```bash
pnpm --filter @neslink/server exec wrangler login
```

```bash
pnpm deploy
```

## Default controls

| Button | Key |
|---|---|
| D-pad | W A S D |
| B / A | J / K |
| Select / Start | V / B |

The keyboard controls 1P. Gamepads (standard mapping) are assigned to 1P and 2P in connection order, so a second local player uses a gamepad. In a room you choose your seat, and the keyboard or any gamepad controls it.
