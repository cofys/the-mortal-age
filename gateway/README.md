# Gateway

Lets the official OSRS client (revision 241, launched through [RSProx](https://github.com/blurite/rsprox))
play on tsps. The gateway speaks the OSRS protocol to the client with
[rsprot](https://github.com/blurite/rsprot) and opens one tsps WebSocket session per player, the
same way the browser client does, translating both ways.

```
official client ── RSProx ── TCP ──▶ gateway (GATEWAY_PORT) ── WebSocket ──▶ tsps (WEBSOCKET_PORT)
```

It is separate from `tools/runelite-gateway`, a single-client RuneLite demo that reads snapshots
from a server plugin instead of tsps's protocol; the two don't share code or ports.
[COVERAGE.md](COVERAGE.md) lists every tsps packet and what it becomes.

## Running

```bash
yarn start          # tsps, as usual
yarn gateway        # the gateway, in a second terminal
yarn gateway:test   # unit tests; the integration tests (it/) need `yarn start` running in this checkout
```

Tests that need `::` commands (teleports, instances) run as tsps's developer account: start tsps
with `DEV_USERNAME=<names>` (comma-separated) and run the tests with the same variable. They play
the last name, so you can play the first one meanwhile. Without it they're skipped; they also
skip while someone is logged in on the tests' account.

```bash
DEV_USERNAME=gwdev,gwtest yarn start
DEV_USERNAME=gwdev,gwtest yarn gateway:test
```

The gateway reads its ports from the root `.env`, the same block `scripts/wt` writes
([docs/worktrees.md](../docs/worktrees.md)): `GATEWAY_PORT` (43595 in the main checkout, 43900 + N
in slot N) and `WEBSOCKET_PORT`. It serves JS5 from the cache in `server/target.txt`.

The login key is generated on first start into `gateway/keys/rsa.txt` (not committed). Startup
prints its modulus for the RSProx target.

Gradle runs on any JDK 11+ and builds with a JDK 17 toolchain. The test client builds RSProx's
revision-241 protocol module from a pinned commit into `gateway/build/rsprox` on first run.

## Connecting the official client

tsps serves a jav_config and world list for RSProx on its own port. `yarn gateway` prints the
target; add it in RSProx as a custom target (YAML):

```yaml
config:
  - name: tsps
    jav_config_url: http://127.0.0.1:<WEBSOCKET_PORT>/gateway/jav_config.ws
    modulus: <printed by yarn gateway>
    revision: 241
    game_server_port: <GATEWAY_PORT>
```

Launch the native client for that target and log in with a tsps account (unknown names are
created, as in the browser).

## Layout

| Package | What |
| --- | --- |
| `config` | `.env` and `server/target.txt` |
| `crypto` | the login RSA key |
| `cache` | dat2/idx reader, containers, reference tables, the JS5 master index |
| `net` | rsprot's network service: JS5 from the cache, login, the 241 codecs |
| `tsps` | the tsps WebSocket and its wire format |
| `session` | per-player state; `GatewaySession` bridges one client to tsps; `EntityWorld` is its rsprot player/NPC/world-entity world |
| `down` | tsps → client translation, one file per domain (interfaces, items, world, social, trade, sync) |
| `up` | client → tsps translation (`Upstream`), with the gateway's own decoder for the character designer |
| `coverage` | counts of dropped messages, logged every minute |

## How it maps tsps to OSRS

[COVERAGE.md](COVERAGE.md) lists every tsps message and client opcode, the revision-241 packet it
becomes, and whether it is mapped, dropped (with a reason) or still to do.

Each official client gets its own rsprot entity world. tsps decides who a player sees, so the
gateway mirrors exactly that view rather than letting rsprot work out visibility.
