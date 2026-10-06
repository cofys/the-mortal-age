# KINGDOM SYSTEM — Design (v1)

The Mortal Age's kingdoms are the weather: territory, war, succession. This is
the data model, the event catalog, and the honest list of what's stubbed.

## Files

`server/plugins/kingdoms/` — additive only, no existing files touched.

| File | Role |
| --- | --- |
| `Kingdoms.plugin.js` | Registration list (attach-only `register`) |
| `KingdomStore.js` | World-state store: `data/saves/kingdoms.json` (plain module, no hooks) |
| `Seed.Kingdoms.js` | Seeds the 5 great powers at server startup, idempotent |
| `Areas.Kingdoms.js` | One `Area` subclass per great power; emits territory edges |
| `Events.Kingdoms.js` | `kingdom:*` custom-event listeners (the cross-plugin API) |
| `Membership.Kingdoms.js` | Player attributes, `::kingdom` / `::kingdomrank` commands, court helpers |
| `Tension.Kingdoms.js` | The powder keg: pairwise tension, skirmishes, war starts/ends, story beats |

## The tension model (live war states)

Every pair of great powers carries a **tension** score (0-100, persisted in
`KingdomStore.tension` under canonical `"a:b"` keys). A tension tick runs
every ~2 minutes (200 game ticks). Tension breathes: it builds, releases,
and recovers — war is an event, not the weather.

| Driver | Numbers |
| --- | --- |
| Peace decay | -1/tick (100 → 0 in ~3.3h of quiet) |
| Border incidents | chance 2% + 15% × (tension/100) per tick; +6..14 tension; 30% become street rumors |
| Skirmishes | at tension ≥ 70, 20%/tick: patrols clash at a named border, 1-4 guards dead per side, +6..12 tension |
| Street rumors | thresholds 55 (grumbling) / 75 (mobilizing) / 90 (war fever + realm announcement), with hysteresis |
| War declaration | at 100: `kingdom:war-declared`; Morytania is the aggressor in its own feuds |
| War duration | 6-18h (`resolveAt` on the war record), or until a side's garrison breaks |
| War attrition | 20%/tick per belligerent loses 1 garrison |
| Peace terms | treasuries drained 15% both sides; tension pinned at 15; garrisons reset to 30; outcome by levies + treasury weight |
| Armistice | 72h after a war: tension capped at 40, decays 2/tick |
| Garrisons | `war:garrison` flag, 60 max; peace rebuilds +1/tick; skirmishes floor at 1; war can zero it (defeat) |
| Scapegoating | a quartermaster's `kingdom:war-demand` makes the court blame its hottest rival (≥30): +4 tension, 1h cooldown |
| Player PK | cross-kingdom kill: +5 tension (+8 for slaying a foreign guardsman); killer earns +15 influence (+25 in wartime) |
| Morytania powder keg | seeded 68-74 at boot; Myreque sabotage 6%/tick and Drakan's tithe demands 5%/tick keep it hot |

**What a player sees, first rumor to peace:** townsfolk repeat spymaster
rumors as tension crosses 55/75/90; merchants charge 1.5× war prices for
steel and food once a border passes 60; skirmishes are announced realm-wide
and citizens speak fear in the streets; at 100 war is declared with a
casus-belli reason, patrols double, war taxes bite, quartermaster demands go
URGENT, entering the kingdom warns you the roads are not safe, and the
market closes; when the war burns out, peace terms are announced, both
treasuries bleed, and `::war` shows the rebuilding. Citizens speak relief;
the armistice holds the peace.

**`::war`** — open wars with reasons, the 5 hottest borders with heat
labels (calm/grumbling/skirmishes/WAR FEVER), and garrison strengths.

## Data model

**World state** (one record per kingdom in the store):
`{ id, name, capital, ruler, rulerTitle, situation, hierarchy, treasury, flags, foundedAt }`.
Wars: `{ attackerId, defenderId, declaredBy, reason, active, declaredAt, endedAt, outcome }`.
Persisted to `data/saves/kingdoms.json` on every mutation; loaded at startup;
reseed never clobbers live treasury/ruler/flags. Delete the file to reset the
world (a fresh seed is planted on next boot).

**Player state** (persisted attributes, kebab-case namespaced keys):
- `kingdom:id` — kingdom the player serves
- `kingdom:rank` — rank title from the kingdom's hierarchy
- `kingdom:titles` — honorifics earned (string array)

**NPC state**: NPCs are `Mobile`s, so courts need no engine changes — a courtier
is `kingdom:id` + `kingdom:rank` + `kingdom:court-role` attributes, applied by
`tagCourtier(npc, kingdomId, rank, role)` from `Membership.Kingdoms`. No court
NPCs are spawned in v1; the tagging helper is ready for when they are.

**Rank ladder** (v1, shared by all five powers):
Outsider → Subject → Man-at-arms → Knight → Lord → Regent → Monarch.

## The five great powers (seed data)

From the world bible; treasuries are v1 seed numbers, not canon.

| Kingdom | Capital | Ruler | Flag |
| --- | --- | --- | --- |
| Asgarnia | Falador | Sir Amik Varze, Lord Regent, Steward of Falador | `asgarnia:regency = true` |
| Misthalin | Varrock | Roald III, King of Misthalin | `misthalin:bastard-son-hidden = true` |
| Kandarin | East Ardougne | King Lathas | `ardougne:plague-lie-active = true` |
| Morytania | Meiyerditch | Lowerniel Drakan, Lord of Morytania | `morytania:salve-integrity = 100` |
| Keldagrim | Keldagrim | The Consortium (Eight Companies, in council) | `keldagrim:red-axe-threat = "rising"` |

## Territory areas (APPROXIMATE — v1)

Each great power is an `Area` subclass covering its capital region, so kingdom
law can be per-tick and per-actor with free `postEnter`/`postLeave` edges.
Rects are rough boxes around the capitals, one `Boundary` per height level
(`Boundary.inside` needs an exact z match): z 0–3 on the surface kingdoms,
z 0 only for underground Keldagrim. Asgarnia stops at the Wilderness ditch
(y 3519). Refine against the cache map before any law depends on exact tiles.
Broad zones register at `onServerStartup` so specific areas (dungeons,
minigames, registered at load) keep priority — first match wins.

| Kingdom | Rect (x1–x2, y1–y2) | Covers (approx) |
| --- | --- | --- |
| Asgarnia | 2880–3040, 3280–3519 | Falador, Burthorpe, Taverley |
| Misthalin | 3072–3296, 3168–3512 | Varrock, Edgeville, Draynor, Lumbridge |
| Kandarin | 2432–2656, 3072–3360 | East/West Ardougne, Yanille |
| Morytania | 3408–3776, 3264–3536 | Canifis, Port Phasmatys, Burgh de Rott |
| Keldagrim | 2816–2944, 10112–10272 | The dwarven city |

Crossing a border emits `kingdom:territory-entered` / `kingdom:territory-left`
(player only, token-lean payload) and shows a short message — "Welcome home"
for citizens, the kingdom's one-line blurb for visitors.

## Event catalog

All cross-plugin traffic goes through these; the emitter owns the name and
payload shape, the listener owns the handler. Payloads stay small on purpose —
they're the seam future LLM hooks (AI citizens, court agents) will read.

- `kingdom:created` `{ kingdomId, name, capital?, ruler?, rulerTitle?, hierarchy? }`
  — a kingdom announced itself. Seed emits it for the five powers; the listener
  upserts idempotently. Later: the player-founded-kingdom path emits this too.
- `kingdom:territory-entered` / `kingdom:territory-left` `{ player, kingdomId, name }`
  — emitted by the Areas. **No core listener in v1**; reserved for external
  consumers (AI citizens reacting to border crossings).
- `kingdom:rank-granted` `{ player, kingdomId, rank?, title? }` — join or
  promotion; writes `kingdom:id` / `kingdom:rank`, appends to `kingdom:titles`.
- `kingdom:tax-collected` `{ kingdomId, amount, source? }` — revenue lands in
  the treasury. (Nothing collects tax yet — see stubs.)
- `kingdom:war-declared` `{ attackerId, defenderId, declaredBy?, reason?, resolveAt? }`
  — the tension engine declares wars at 100 tension (`declaredBy: "tension"`);
  `resolveAt` is the ms timestamp when the war burns out if nothing ends it sooner.
- `kingdom:war-ended` `{ attackerId, defenderId, outcome? }`
  — the tension engine ends wars (burnout, broken levies) with peace terms.
- `kingdom:skirmish` `{ attackerId, defenderId, location, casualtiesA, casualtiesB }`
  — border patrols clashed below the threshold of war; citizens speak fear.
- `kingdom:ruler-changed` `{ kingdomId, newRuler, newTitle?, flag?, flagValue? }`
  — succession, coup, or questline (e.g. Lathas falls → flag flip).

## What's stubbed for later

- **Player-founded kingdoms** — "you can try, you will probably die." The
  `kingdom:created` listener already accepts new kingdoms idempotently, but
  there is no founding flow: no charter cost, no territory claim, no army
  muster, and no existing-power retaliation. All of that is content to build.
- **War mechanics** — declaration and resolution are now simulated by the
  tension model (Tension.Kingdoms.js): wars start at 100 tension, burn 6-18h
  or until a garrison breaks, and end with peace terms, drained treasuries,
  and a 72h armistice. Still stubbed: no battles, no territory flipping on
  outcome, no war weariness beyond garrison attrition. Area rule overrides
  (`canAttack` wartime PvP law, Morytania guard aggression, Keldagrim company
  checkpoints) are stubbed to `null`.
- **Tax collection** — the treasury has a door but no foot traffic. Shop taxes,
  market tolls, and war levies need emitters in the economy/skilling content.
- **Courts and AI rulers** — `tagCourtier` is ready; spawning kings, generals
  and spymasters with real hierarchies (pillar 1) is future content.
- **The doomsday clocks** — `morytania:salve-integrity` starts at 100 and
  nothing decays it; `keldagrim:red-axe-threat` starts at `"rising"` and nothing
  escalates it. These want slow tick content, not per-tick area work.
- **The bastard son** — `misthalin:bastard-son-hidden` is a story flag for the
  questline, not plugin logic. The Church, the gangs and the palace move when
  the claim surfaces — that's custom quest content.
- **Per-kingdom hierarchies** — one shared ladder for v1; the Consortium's
  company ranks and Lowerniel's blood court deserve their own.
- **Area `process()`** — intentionally empty in v1. Kingdom law should be
  event-driven (edges, wars, ticks on the slow clocks), not per-actor per-tick.
