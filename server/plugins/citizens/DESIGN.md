# CITIZEN SYSTEM — Design (v1)

The AI population of The Mortal Age: believable agents that **play the game for
real** — skilling, trading, guarding, socializing — instead of looping bot
tasks. Scripted body (BotBrain activities) + LLM mouth (the llm-gateway
plugin), per the world bible's "AI citizens" pillar.

## Phase 1: make it feel like a world

The wilderness PK population ships as-is; this system owns the **cities**.
Every capital is seeded on first boot with a street-level mix, so a player
walking through Varrock SEES people living there:

| Capital (kingdom) | Guards | Merchants | Commoners | Courtiers | Total |
|---|---|---|---|---|---|
| Falador (Asgarnia) | 3 | 2 | 6 | 2 | 13 |
| Varrock (Misthalin) | 3 | 2 | 6 | 2 | 13 |
| East Ardougne (Kandarin) | 3 | 2 | 6 | 2 | 13 |
| Meiyerditch (Morytania) | 3 | 2 | 6 | 2 | 13 |
| Keldagrim | 3 | 2 | 6 | 2 | 13 |
| **Total** | | | | | **65** |

What they're doing, by role:

- **Guards** — walking closed patrol circuits around the capital (data/sites.json),
  challenging strangers who don't share their `kingdom:id`. Three watches rotate
  so the walls are manned day and night; off-watch guards drink at the tavern.
- **Merchants** — tending stalls at the market: advertising wares, selling bread
  for coins through real inventory ops, walking to the bank to restock.
- **Commoners** — living the daily routine (home → work → tavern → home). Work is
  seeded per citizen: ~40% become **fishers** at the capital's dock/water
  (Port Sarim for Falador, Draynor riverbank for Varrock, Port Khazard for
  Ardougne, the coast for Meiyerditch), the rest gather at the kingdom's
  tree/rock site with real XP and banked output. Keldagrim is underground — no
  dock — so its commoners all mine.
- **Courtiers** — attending the court 09:00–17:00, tavern evenings.

All default deployments are the capitals. Nothing here spawns in the wilderness.

## How it fits the existing bot stack

- Bots are full `Player` entities (`BotPlayerSession`, no client). Citizens are
  bots with `citizens:*` attributes; they never take human player slots.
- **All per-tick logic lives in BotBrain activities.** `World.process()`
  deliberately skips `emitPlayerProcess` for bots, so nothing here uses player
  hooks — only the action contract (`update(ctx) -> "running"|"wait"|"success"|
  "failed"`, `stop(ctx)`), per-bot state via `playerState` (ActionState), and
  movement via `requestMovement` (dispatched by `BotBrain.dispatchMovement`).
- **One shared activity registry.** Citizen activities compile into the bots
  plugin's `BotActivityRegistry` through a small extension seam
  (`registerBotActionType`, `registerBotConditionKind`,
  `appendActivityDefinitions`, `getBotActivityRegistries()` — the only edits to
  an existing bot brain file, confined to the catalogue registration). The
  `citizen` requires-condition (`{citizen:{roles:[...], kingdoms?}}`) means
  base bots (wilderness roamers, skillers) can never draw citizen activities,
  and citizen bots re-pick within the citizen pool on idle.
- The director attaches brains with `attachBrain` (same as sites/bench) and
  switches phases with `startActivity` from `BrainActivities`.

## Activities (4 new BotBrain actions)

| Action | Activity | Mode | What it does |
|---|---|---|---|
| `GuardPatrol` | `guard_patrol` | `citizen_guard` | Walks a closed waypoint circuit from `data/sites.json`, log-normal lingers, waypoint noise, occasional misclicks. Scans local players every ~8s and `forceChat`-challenges strangers (anyone not sharing its `kingdom:id`). On war alert: faster pace, sharper lines. |
| `Merchant` | `merchant_tend` | `citizen_merchant` | Tends a market stall: advertises wares on log-normal gaps, sells bread for coins via real inventory ops (`deleteNumber`/`add`), walks to the bank and restocks with the same `Bank.withdraw` pattern `Bank.js` uses. Packs up and goes home on war alert. Coin income feeds the `save_gold` goal. |
| `CitizenRoutine` | `citizen_routine` | `citizen_routine` | The commoner's day from the wall clock: home → work → tavern → home, with seeded per-day variation (±45min boundaries, swapped shifts, rare days off). Work kind is seeded per citizen: **fisher** (dock shifts: walk to the water, cast on a human rhythm with fishing chatter, hauls counted toward the goal) or **gatherer** (delegates to the shared `interactObject` action at the kingdom tree/rock site, internal bank trip when full — real XP and real banked output feeding the `master_trade` goal). |
| `IdleSocial` | `courtier_attend`, `tavern_social` | `citizen_social` | Hangs around a court/tavern anchor: drifts between nearby tiles, personality-scaled chatter, gathers tighter on war alert. Also used as CitizenRoutine's social-phase delegate. |

Definitions live in `data/citizen-activities.json` (data-driven, like
`bot-activities.json`). Capacities are modest (32–64); execution budgets and
LOD strides apply unchanged.

## The AI Director (`director/CitizenDirector.js`)

Not a task loop — a population manager. On a ~60s `Task` tick it reconciles
each citizen's **desired phase** against reality:

- **Roles & spawn placement.** Roster from `CITIZEN_PLAN` (JSON) or the
  default (2 guards, 1 merchant, 3 commoners, 1 courtier per great power).
  Each citizen gets a seeded personality (`lib/personalities.js`: name, role,
  kingdom, 2 traits, 1 quirk), a home tile near its kingdom's market, and
  `kingdom:id` + `kingdom:rank` attributes.
- **Circadian scheduling.** Guards rotate three watches (off-watch → tavern);
  merchants keep shop 08:00–19:00; courtiers attend court 09:00–17:00 then the
  tavern; commoners run their routine. Everyone has a seeded sleep window —
  **sleeping citizens log out** (`requestLogout`; the runtime's
  `onPlayerLogout → handleDisconnect` drops their entry). Logged-out bots cost
  zero; the roster record (personality, goal, schedule) survives and they
  re-spawn at wake.
- **Goals (`lib/goals.js`).** `save_gold` (merchants, sampled from
  inventory+bank coins), `rank_up` (guards accrue duty-hours; completion
  promotes along Man-at-arms → Knight → Lord via `kingdom:rank-granted`),
  `master_trade` (commoners count banked work cycles). Completion escalates
  the target tier and assigns the next goal.
- **Kingdom membership.** Citizens join through the kingdoms plugin's own
  contract: the director emits `kingdom:rank-granted` (its Events module
  applies the attributes) and sets them directly for immediacy. Ranks come
  from the shared hierarchy (Man-at-arms / Subject / Lord).

`::citizen status|spawn` (ADMINISTRATOR) for ops. Boot gated on
`CITIZENS_ENABLED=1` — default off, the shipped wilderness population is
untouched.

## Humanizer (`lib/humanizer.js`)

- **Timing:** log-normal jitter (`logNormalJitter(rng, median, sigma)`), never
  uniform sleeps. Per-agent sigma from traits (fidgety 1.0 → methodical 0.45).
- **Movement:** waypoint noise (uniform disc), occasional 1–2 tile misclicks
  corrected on the next decision, idle pauses before moving off.
- **Social:** chat gaps scaled by `chatRate` (chatty 1.6 → taciturn 0.4);
  guard challenge eagerness by `challengeRate`.
- All RNG is seeded per username (`agentRng`), so a citizen is the same person
  across logins but the population varies.

## Kingdom wiring

- Reads the five great powers from the **kingdoms plugin** (ids, names,
  rulers, situations via read-only `KingdomStore.getKingdom`).
- Physical anchors (court, market, tavern, bank, patrol circuit, work site)
  are citizens-side data: `data/sites.json`, keyed by kingdom id.
  Coordinates are approximate OSRS tiles — tune in-game.
- Reacts to `kingdom:war-declared` / `kingdom:war-ended` (tracked in
  `CitizenEvents.js`; guards patrol harder, merchants close, commoners stay
  home, courtiers gather). No reaching into kingdom internals beyond the
  read-only store lookup.

## Chat interface (llm-gateway owns the mouth)

Established contract (see `server/plugins/llm-gateway/LlmGateway.plugin.js`):

- `llm:citizen-register` `{username, personalityCard, replyCooldownMs?}` —
  **emitted by the director on every spawn** (`chat/CitizenChat.js` builds the
  card from the personality seed + kingdom situation).
- `llm:chat-request` `{citizenUsername, requesterUsername, text, channel}` —
  private messages are already intercepted by llm-gateway's ChatInterceptor.
- `llm:chat-response` — spoken by llm-gateway's Mouth (forceChat + packets).

**Stubbed:** `citizens:chat-heard` `{citizenUsername, speakerUsername, text}`.
Public chat near a bot cannot be intercepted today — core broadcasts it with
no plugin hook (documented in `llm-gateway/ChatInterceptor.js`). The event,
payload shape, and forwarder (`onCitizenChatHeard` → `llm:chat-request`,
channel `public`) are defined and wired; nothing emits it in v1. Ambient
scripted speech (guard challenges, merchant ads, tavern lines) uses
`forceChat` directly and needs no LLM.

## What's stubbed / deferred

- **Fishing catches.** Fishers do the full visible behavior (dock shifts, cast
  rhythm, chatter, hauls counted toward goals), but landing actual fish needs
  a brain NPC-interaction path: the brain world has `objectSearch` but no NPC
  search, and the plugin api exposes `emitObjectInteraction` but not
  `emitNpcInteraction` (`PluginManager.emitNpcInteraction` exists in core —
  it's just not on the api facade). Follow-up: expose it and add an
  `npcSearch` to the brain world; then a `fishSpot` action can click real
  "Fishing spot" NPCs through the Fishing skill plugin.
- `citizens:chat-heard` emission (needs a core public-chat hook; one-line
  proposal lives in llm-gateway's ChatInterceptor notes).
- Citizen death respawn (no persistent respawn resolver; cities are safe, but
  a killed citizen currently stays dead until its next scheduled wake).
- Merchant customer side is abstract (sales tick, no real trade windows);
  a shop-front interface can replace `sellTick` later. (Done 2026-10-06:
  `shop/MerchantShops.js` — Trade player-option opens a stall backed by the
  merchant's live inventory; the abstract `sellTick` still runs for
  passers-by alongside real player trades.)
- `KingdomStore.getKingdom` is required directly (read-only) for personality
  cards — a `kingdom:describe` query event would remove the last cross-plugin
  reach-in; proposed, not blocking.
- No persistence of roster/goals across restarts (bots skip persistence by
  design); the roster rebuilds deterministically from `CITIZEN_PLAN`.

## Performance

- Actions do O(1) work per tick; the only scans (guard stranger check) run
  every ~8s over `getLocalPlayers()` (already computed for the update
  protocol). Director work is one pass per 60s over a small roster.
- Bots ride the existing `BotBehaviorTask` budgets (30ms/cycle, LOD strides,
  idle stride) — citizens are just more entries.

## Files

```
server/plugins/citizens/
  Citizens.plugin.js            plugin entry (attach-only register)
  constants.js                  attribute keys, roles, modes, event names
  CitizenEvents.js              war/alert tracking from kingdom:* events
  DESIGN.md                     this file
  data/sites.json               physical anchors per kingdom (approx. tiles)
  data/names.json               name pools
  data/citizen-activities.json  the 5 citizen activities
  lib/humanizer.js              log-normal jitter, noise, misclicks, profiles
  lib/personalities.js          personality seeds + llm-gateway cards
  lib/goals.js                  save_gold / rank_up / master_trade
  brain/CitizenSites.js         site resolution by kingdom attribute
  brain/CitizenActionTypes.js   catalogue extension registration
  brain/CitizenActivityRegistry.js  compiles citizen activities into the registry
  brain/actions/GuardPatrol.js
  brain/actions/Merchant.js
  shop/MerchantShops.js         Trade option + stall UI on the merchant's live inventory
  brain/actions/CitizenRoutine.js
  brain/actions/IdleSocial.js
  chat/CitizenChat.js           llm:citizen-register + chat-heard stub
  director/CitizenDirector.js   roster, spawn, circadian schedule, goals
```

Only existing file touched: `server/plugins/bots/brain/BotActivityRegistry.js`
(extension seam: `registerBotActionType`, `registerBotConditionKind`,
`appendActivityDefinitions`, `getBotActivityRegistries`, `world` on the
registry object).
