# Independent relay nodes

The Cloudflare Worker remains the control plane: rooms, seating, starting, signaling,
spectator history and a fallback input route. A selected standalone Node.js relay adds
an input route directly between browsers. It never calls the controller, and the
controller never calls it. WebRTC, the selected relay, and the room route can carry
the same inputs; the first received copy is used. Relay failure does not stop play.
This is an input relay, not a TURN server; the existing optional TURN configuration
continues to work independently.

## Controller configuration

Set `RELAY_NODES` on the Cloudflare Worker to a JSON string containing public metadata:

```json
[
  { "id": "tokyo", "name": "Tokyo", "url": "https://relay-tokyo.example.com" },
  { "id": "singapore", "name": "Singapore", "url": "https://relay-sg.example.com" }
]
```

URLs must be HTTPS origins without paths, query strings or credentials. HTTP is
accepted only on loopback for development. There can be at most 16 external nodes;
`main` is reserved for the built-in room server. `[]` preserves the original setup.

Use `apps/server/wrangler.jsonc` → `vars` for public metadata. Store the corresponding
signing material as the **Worker secret** `RELAY_SIGNING_KEYS`, not in `vars` or Git:

```sh
pnpm --filter @neslink/server exec wrangler secret put RELAY_SIGNING_KEYS
```

Its JSON shape is:

```json
{
  "tokyo": { "kid": "2026-01", "secret": "BASE64URL_RANDOM_KEY_FOR_TOKYO" },
  "singapore": { "kid": "2026-01", "secret": "DIFFERENT_BASE64URL_RANDOM_KEY_FOR_SINGAPORE" }
}
```

Generate at least 32 random bytes **per node**, for example locally with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

For local development, put `RELAY_NODES` and `RELAY_SIGNING_KEYS` in the ignored
`apps/server/.dev.vars` file. Values must be quoted/escaped according to Wrangler's
dotenv format. Do not put keys in any `VITE_*` variable.

## Deploy a node

Requirements: Node.js 24+, pnpm 12.14.0, a writable persistent directory, and an
HTTPS/WSS reverse proxy (Caddy or equivalent). No Rust, Cloudflare account, Redis,
or connection to the controller is required on a standalone node.

Configure these environment variables through your deployment secret manager:

| Variable | Meaning |
| --- | --- |
| `RELAY_NODE_ID` | The matching controller node ID, e.g. `tokyo` |
| `RELAY_KEYS` | JSON object `{"2026-01":"THE_SAME_RANDOM_KEY_FOR_THIS_NODE"}` |
| `RELAY_ALLOWED_ORIGINS` | Optional exact-origin restriction, comma separated; defaults to `*` (any website with a valid signed ticket) |
| `RELAY_REPLAY_DB` | Persistent SQLite path; default `data/relay-tickets.sqlite` relative to the node working directory |
| `HOST` | Bind address, default `127.0.0.1`; use `0.0.0.0` inside a container |
| `PORT` | HTTP listen port, default `8788` |
| `RELAY_MAX_CONNECTIONS` | Hard connection cap, default `1024` |
| `RELAY_PROBE_ONLY` | Set `1` to serve public probes and reject all WebSocket connections; allows an empty origin list while the controller is not configured |
| `RELAY_ALLOW_INSECURE` | Set `1` to explicitly accept non-loopback HTTP website origins; HTTPS is the default |

```sh
pnpm install --frozen-lockfile
pnpm --filter @neslink/relay start
```

Or build the container from the repository root:

```sh
docker build -f apps/relay/Dockerfile -t neslink-relay .
```

Pass the variables using your secret manager or an ignored env file, publish the
port behind TLS, and mount a persistent volume at `/app/data`. Example Caddy config:

```caddyfile
relay-tokyo.example.com {
    reverse_proxy 127.0.0.1:8788
}
```

Run **one process/container per node ID**, retain its database volume across
restarts, and keep system clocks synchronized. SQLite atomically consumes ticket
IDs and retains them until expiration. Running independent replicas with the same
ID but separate databases would break one-use guarantees; horizontal replicas
would need a shared atomic replay store first. On storage failure authentication
fails closed. The input relay itself keeps no durable game state.

### HTTP/WS without a domain or certificate

An IP/port endpoint can be used with an explicit controller-side
`RELAY_ALLOW_INSECURE=1`; HTTPS remains the default. If the website itself also
uses non-loopback HTTP, set the node's `RELAY_ALLOW_INSECURE=1` and list that
exact HTTP website origin. This retains signed, expiring, single-use admission;
it does not encrypt tokens or input traffic. Browsers normally block HTTP probes
and WS connections from an HTTPS website as mixed content. This setting cannot
override the browser restriction, and emulator APIs may require a secure context.

A node can be deployed before configuring a controller: give it the node ID and
verification key, and leave `RELAY_ALLOWED_ORIGINS` unset (defaults to `*`). No
website URL is required. Any website may attempt a connection, but only a valid
signed ticket is admitted; its origin must still match the handshake origin.
Later configure the matching signing key on the controller. `RELAY_PROBE_ONLY=1`
is an optional maintenance mode that disables all game admission. There is no
unauthenticated game mode.

## Selection and measurements

Every client directly probes every configured node while in the lobby; the main
route uses its actual room WebSocket RTT, not a nearby HTTP edge. `GET /health`
is public, sends `Cache-Control: no-store`, and permits
cross-origin requests without cookies or keys. After a warm-up request the client
collects three samples, displays median RTT and range (jitter), then refreshes
every 15 seconds. Failed/incomplete probes are marked unavailable; reports older
than 45 seconds are omitted.

Everyone sees the same table, including spectators. Only the current host can
change automatic/manual selection; this is checked on the controller, not only
by disabling the UI. Automatic mode minimizes the sum of the two slowest seated
players' half-RTTs plus jitter; spectators do not influence it while seats are
occupied. The built-in route participates too. The selected node is frozen at
game start. These public HTTP measurements are routing estimates, not a guarantee
of game latency, throughput, packet loss, or a full two-client path measurement.
Authenticated WebSocket RTT and fallback status are shown during play.
Measurements are self-reported routing hints; they never grant permissions or
replace the node's signature and seat checks.

Run `pnpm test:integration` after installing dependencies to exercise the real
local Wrangler/workerd controller and a standalone relay, including permissions,
ticket issuance, spectator joining and fallback. This uses an isolated temporary
controller config and test-only keys; it does not deploy anything.

## Connection authorization

1. The controller privately gives each live room connection a random capability
   in its `welcome` message. It is kept in worker memory, excluded from public
   room state, and is invalid once that control connection leaves.
2. After game start the browser POSTs that capability to the same-origin
   `/api/rooms/:id/relay-ticket` endpoint. The controller checks the live player,
   selected node and active game; issuance is limited to once per two seconds
   per connection. Responses are `no-store`.
3. The controller issues an HS256 JWT valid for **30 seconds** with a random
   `jti`, fixed issuer/type, exact node audience, website origin, room, game UUID,
   player ID and server-assigned seat. Signing keys and ticket-issuing code never
   reach the browser. The signature format is standard JWS, using the `jose` library.
4. The browser connects directly to the configured node and submits the ticket
   in its first WebSocket message. It is never put in a URL, cookie, localStorage
   or sessionStorage. Before authentication, no room data is sent. Authentication
   times out after five seconds, and pending connections have global/per-IP caps.
5. The node pins HS256, checks issuer/type/key ID, audience, Origin, room and
   lifetime, then atomically inserts the `jti` into persistent SQLite. Even
   concurrent submissions can succeed only once. The server-assigned seat is
   enforced on each input; spectators cannot submit input. Different games are
   isolated. Reconnecting always requests a fresh controller ticket.

The 30-second deadline is an **admission window**, not the lifetime of a successful
connection. Accepted sockets remain usable during the game. Since the node is
offline from the controller, revocation is not immediate: a stolen unconsumed
ticket can be used until it expires, and an already accepted socket is not remotely
revoked by the controller. The normal client closes its relay when the game ends.
Tokens are bearer capabilities; HTTPS/WSS, protecting server keys, and preventing
frontend XSS remain necessary. Public rooms still use shareable room links and
do not become private or user-authenticated because relay tickets exist.

For rotation, add a new `kid` and key to a node's `RELAY_KEYS`, then switch that
node's active key in the controller. Retain the previous node key for at least
30 seconds plus clock/deployment margin before removing it. Each node has its
own secret, limiting the scope of a node compromise. Apply ordinary reverse-proxy
connection/request limits and controller rate limits for public deployments.
Do not log credential responses or authentication message bodies.

References: [JWT best practices (RFC 8725)](https://www.rfc-editor.org/rfc/rfc8725.html),
[OWASP WebSocket security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html).
