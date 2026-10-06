# ARRIVAL — Design (v1): the starting experience

The first 15 minutes of The Mortal Age are a **situation, not a quest chain**.
The player arrives home, gets their bearings from a guard and a townsfolk,
hears the world's state as ambient rumor, and gets one gentle nudge toward
the living world. Footing and a nudge, not a checklist.

**Hard rules for this plugin:**
- No quest keys, no varps, no stages, no QPs, no objectives. If a future
  change adds a checklist here, it has failed and should be reverted.
- Every line of world-state content is **flag-driven**: it reads the live
  story flags in KingdomStore and goes silent or flips when the world moves.
  Nothing here hardcodes "the king is missing" — it asks the store.
- The plague *lie* exists as ambient whisper. The questline that exposes it
  is phase 10 and is **not** built here.

## Files

`server/plugins/arrival/` — additive only, no existing files touched.

| File | Role |
| --- | --- |
| `Arrival.plugin.js` | Registration list (attach-only `register`) |
| `Common.Arrival.js` | Shared helpers: `later`, `isRealPlayer`, `npcNamedNear`, `CAPITAL_ZONES`, `kingdomAt` |
| `Origins.Arrival.js` | The welcome beat on `origins:selected` |
| `Rumors.Arrival.js` | The ambient rumor engine: flag-gated pools + `rumorsFor`/`drawRumor` |
| `Chatter.Arrival.js` | NPC idle rumor chatter in the capitals |
| `Asides.Arrival.js` | Bartender dialogue asides (canon verbatim + muttered aside) |
| `Noticeboards.Arrival.js` | `Read` a Noticeboard → the kingdom's broadsheet |
| `DESIGN.md` | This file |

## 1. The welcome beat (`Origins.Arrival`)

Listens for the origins system's `origins:selected` `{ player, originId }`
event. One beat per origin, then never again (`arrival:welcomed` attribute,
set before the beat runs — re-emits are no-ops):

1. **Placement.** If the player is more than 40 tiles from their origin's
   arrival tile, they are moved there. (Assumption: the origins system may
   take over this teleport; if it does, this step becomes a natural no-op.)
2. **The greeting** (t+2 ticks). A nearby Guard — or a townsfolk in
   guardless Burgh de Rott, a dwarf in Keldagrim — forceChats a line that
   names the local crisis *as the flags describe it right now*:
   - Falador: *"Welcome to Falador, traveller. Keep your head down — the regent's men are asking questions today."*
   - Varrock: *"New in Varrock? Mind the gangs in the east alleys — and pray for the king. He's old, there's no heir, and everyone's nervous."*
   - East Ardougne: *"Welcome to Ardougne. Stay EAST of the wall — the west side's quarantined. Plague, they say."*
   - Burgh de Rott: *"You're new. Keep quiet, keep moving, and don't bleed where the vyres can smell it."*
   - Keldagrim: *"Hail, surfacer. Mind the Consortium's writs, keep your hands off other companies' claims. The city's jumpy."*
   - Lumbridge (wanderer): *"Welcome to Lumbridge, traveller. Goblins west, the Duke's men at the castle. You'll find your feet."*
3. **The pointing** (t+16). A Man/Woman forceChats the civic orientation:
   bank/market/tavern in one breath. (*"Bank's north of the square. The Blue
   Moon's south-east, if you need a drink and a rumor."*)
4. **The nudge** (t+30). One gentle pointer toward the living world — the
   citizens' real anchors (docks, work sites, markets from their
   `data/sites.json`): *"The market's always hiring porters, and the fishers
   work the south docks. Pick a crowd, make yourself useful."* Not a task.
   No reward. Just a direction with people in it.
5. **The hand-off.** `arrival:player-arrived` `{ player, originId, kingdomId }`
   is emitted for the citizens system (see §4).

**Skippable by walking away:** each delayed line checks the player is still
within 15 tiles of the greeter before speaking. Walk off mid-beat and the
rest never happens. No NPC is spawned for the beat — it borrows whoever is
already standing there, and falls back to chatbox messages if the square is
empty.

## 2. The ambient rumor engine (`Rumors.Arrival`)

`RUMOR_POOLS`: short rumor lines per kingdom, each optionally gated by a
flag condition (`equals`, `ne`, `lt/lte/gt/gte`, `oneOf`). `rumorsFor(kingdomId)`
reads the flags live from KingdomStore (read-only require — the same seam
the citizens plugin and the bastard-of-varrock quest already use) and returns
only the lines whose conditions hold. `drawRumor` picks one.

The pools ship with both sides of every crisis: regency *and* the king's
return, the plague lie *and* its exposure, the Salve holding / thinning /
broken, the Red Axe rising / at war / defeated. When the world's state moves,
the chatter moves with it — no content edits needed.

Three surfaces, one engine:

- **Idle chatter** (`Chatter.Arrival`): every ~2–4 minutes, one Man, Woman,
  Guard, Dwarf, or Town crier in a capital forceChats a live rumor — but
  only if a real player is close enough to hear it. One event per cycle
  across all capitals, never per-city spam.
- **Bartender asides** (`Asides.Arrival`): the VarrockPolitics pattern —
  canon dialogue lines play verbatim, a muttered aside is appended, matched
  by normalized canon text. Flag-gated at dialogue time. Kaylee in Falador
  (regency talk), Tina in East Ardougne (**the plague whisper**:
  *"…my cousin swears no one's actually sick behind that wall"*), plus
  fallback-line bartenders in Morytania/Keldagrim keyed by territory.
  Misthalin is deliberately skipped — bastard-of-varrock owns Varrock's
  tavern politics and the two must never double-append.
- **Notice boards** (`Noticeboards.Arrival`): `Read` on any Noticeboard in a
  capital prints the kingdom's broadsheet — a pinned civic notice plus the
  three freshest live rumors. The city's situation, readable in one glance.

## 3. The nudge (§1 step 4, and §4)

The nudge is a line of dialogue, not a mechanic: it aims the player at where
citizens are already skilling (docks, work sites, markets) rather than at an
objective. The mechanism behind it is the `arrival:player-arrived` event —
the citizens system can steer a nearby citizen to notice the newcomer (a
wave, a *"new face!"*), so the first social contact in the game comes from a
resident, not a quest giver.

## 4. Contract with the citizens system

Citizens (`plugins/citizens/`, in flight) owns the living world; arrival only
needs two things from it:

- **Emitted by arrival, consumed by citizens (defined here):**
  `arrival:player-arrived` `{ player, originId, kingdomId }` — fired once,
  right after the welcome beat, when a real new player arrives at home.
  Suggested handling: bias a nearby citizen's social behavior toward the
  newcomer for the next minute. Optional, ambient, no gameplay effect.
- **Assumed by arrival, owned by citizens:** `data/sites.json` anchors
  (dock/work/market tiles per kingdom id) are the real places the nudge
  lines point at. The nudge copy in `Origins.Arrival` was written against
  the current sites.json; if the anchors move, the copy should move with
  them. No code dependency — copy only, documented here.

When the LLM gateway lands, the rumor engine's pools are the natural
grounding corpus for citizen small-talk: `rumorsFor(kingdomId)` is already a
function any plugin can call.

## 5. Assumptions about the origins system (parallel build)

- Event name `origins:selected`, payload `{ player, originId }`, fired once
  on first login for real players. Arrival also reads the `origin:id`
  attribute name from the contract (sets `origin:id = "wanderer"` only when
  the event carried an unknown id).
- `kingdom:id` is set by the origins/kingdoms side; arrival does not write
  it. Arrival derives `kingdomId` from its own origin table for the
  hand-off event.
- Origin ids: `asgarnia, misthalin, kandarin, morytania, keldagrim, wanderer`.
  Unknown ids degrade to the wanderer beat (Lumbridge), never a crash.
- Arrival teleports to the arrival tile only when the player is far from it;
  if the origins system places the player itself, this is a no-op.

## 6. What was verified

- `node --check` on all 7 files: pass.
- Hook wiring (fake api): `origins:selected`, `npc-dialogue:line`,
  `Noticeboard → Read`, and the startup chatter task all attach.
- Welcome beat (fake player/NPCs): far player teleports to the arrival
  tile; `arrival:welcomed` set; three lines fire in order
  (greet → point → nudge); `arrival:player-arrived` emitted with
  `{ originId, kingdomId }`; second `origins:selected` is a no-op;
  walking away after the greet cancels the remaining lines and the hand-off.
- Rumor engine: every `when` flag key exists in the kingdoms seed defs;
  always-on lines survive an empty store; flipping
  `ardougne:plague-lie-active` true→false swaps the pool from 4 whisper
  lines to the exposure line; salve 100→30 flips Morytania's tone;
  Kaylee/Tina asides fire only when their flag is live and the canon line
  matches verbatim; non-matching text is untouched.
- Bartender fallback: Keldagrim/Morytania fallback-line bartenders get a
  territory aside; Misthalin fallback bartenders are untouched (no
  double-append with VarrockPolitics).
- Notice board in Varrock prints the pinned palace notice + live rumors; a
  board outside any capital zone prints the rain-blurred line.
- Capital zones: no overlaps; Lumbridge resolves into the Misthalin zone.

## 7. What's stubbed / deferred

- **The origins system itself** — the event, the attributes, and the
  character-creation flow are being built in parallel. Arrival listens; it
  does not create origins.
- **Citizen reaction to `arrival:player-arrived`** — the event is defined
  and emitted; no listener exists yet. The citizens plugin should add one.
- **LLM mouths** — chatter and asides are scripted `forceChat` lines. When
  the gateway is live, `rumorsFor` is the grounding function for citizen
  small-talk; the scripted lines stay as the silent-mode fallback.
- **Notice board UI** — chatbox text in v1. A proper broadsheet interface
  can replace the messages later without touching the engine.
- **Per-NPC rumor memory** — chatter doesn't remember what it said; repeats
  are possible across cycles. Acceptable for ambient muttering.

---

## The first 15 minutes: a Varrock walkthrough

*Written like a film scene. This is the spec — the code above is the camera.*

**MINUTE 0 — FADE IN.** Black. A single line of text, white on black:
*"The gods are silent. The king is old. Varrock doesn't know it's holding its breath."*
Fade to the fountain square. Midday light, pigeons, market noise. The player
stands at the square's edge — new boots, empty pack, no idea where anything
is. A Guard leans on his spear ten feet away, watching the crowd the way men
watch crowds when they're paid to notice things.

**MINUTE 1 — THE GREETING.** The guard pushes off the wall and walks over —
not far, just close enough to be heard. Overhead text, plain as a man
talking: *"New in Varrock? Mind the gangs in the east alleys — and pray for
the king. He's old, there's no heir, and everyone's nervous."* He doesn't
offer a quest. He doesn't mark the map. He goes back to his wall. The player
has just learned the single most important fact about Misthalin politics
without reading a wiki, and it came from a man with a spear, not a cutscene.

**MINUTE 2 — THE POINTING.** A woman with a market basket is already talking
before the player asks: *"Bank's north of the square. The Blue Moon's
south-east, if you need a drink and a rumor."* Two landmarks, one habit
(drink = information). The player now knows where money sleeps and where
talk lives. She walks on. Nothing was asked of them.

**MINUTE 3 — THE NUDGE.** Same woman, half-turned, over her shoulder:
*"The market's always hiring porters, and the fishers work the south docks.
Pick a crowd, make yourself useful."* Not a quest. No exclamation mark, no
tracker. Just a direction with *people* in it. If the player walks away
mid-sentence, she stops talking — the beat is skippable by construction.

**MINUTES 3–5 — FOOTING.** The player drifts. This is the designed drift:
the square is dense on purpose. The bank is where she said it was. The Blue
Moon's door is open. Somewhere behind them, unprompted, a Town crier or a
loitering Man mutters overhead: *"Both gangs are buying old church records.
Birth rolls, ledgers. Ask yourself why."* The player didn't talk to anyone.
The city talked anyway. That's the rumor engine doing its job — the
succession vacuum, readable in the street.

**MINUTE 6 — THE TAVERN.** Inside the Blue Moon Inn. The player clicks the
bartender. Canon plays verbatim — *"What can I do yer for?"* — and then,
quieter, appended like an afterthought: *"…Quiet in here. Everyone's too
busy whispering about the king's health to drink."* (That's VarrockPolitics'
aside; arrival's own asides do the same work in Falador, Ardougne, Burgh de
Rott, Keldagrim.) The player buys a beer or doesn't. Either way they've now
heard the crisis from three different mouths: a guard, a stranger, a
bartender. No quest log updated. No checklist grew.

**MINUTES 7–10 — THE NUDGE PAYS OFF.** The player follows the nudge south
toward the docks — or doesn't; the market works too. Either way they find
*citizens already there*: AI fishermen casting off the south docks, porters
hauling at the market. Someone's forceChat flickers: a catch complaint, a
price gripe. The player fishes beside them. This is pillar 3 and the design
philosophy in one frame — skilling is social because the fishermen talk,
compete, and share rumors. The loneliest loop in RuneScape just became a
social one, and the player chose it freely because a woman with a basket
pointed at people instead of objectives.

**MINUTE 11 — THE BOARD.** Back through the square, the player clicks the
Noticeboard. The broadsheet: the palace's pinned notice (*"His Majesty King
Roald III is indisposed. Prayers for the king's health daily at the
cathedral…"*) and three street rumors, live from the flag engine. The whole
kingdom's situation in one glance. The player now *understands* Varrock:
old king, no heir, nervous church, feuding gangs.

**MINUTES 12–15 — THE WORLD BREATHES.** The player is on their own now, and
that's the point. Maybe they keep fishing with the citizens. Maybe they walk
the east alleys the guard warned about and hear another rumor. Maybe they
head for the palace. Nothing told them to. The arrival plugin has gone
quiet — its job was footing and a nudge, and both are done. The situation
holds them, not a checklist.

**FADE OUT** on the square. The guard is still on his wall. The city keeps
muttering. The gods are still silent.

*End of scene. The rest of the game is the player's.*
