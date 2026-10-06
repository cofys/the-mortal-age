# ORIGIN SELECTION — Design (v1)

The Mortal Age's Mount & Blade-style home pick: at character creation the
player chooses a HOME from the five great powers (or wanders). The pick is the
"feels like home" anchor — starting location, starting kit, and the initial
political lens. The `origins:selected` event is the seam the
starting-experience system hooks for footing + ambient rumor.

## Files

`server/plugins/origins/` — additive only, no existing files touched.

| File | Role |
| --- | --- |
| `Origins.plugin.js` | Registration list (attach-only `register`) |
| `Data.Origins.js` | The six origins: ids, spawns, kits, lens text; kit item keys validated against `ItemIdentifiers` at startup |
| `Selection.Origins.js` | Login/Play-button triggers, the dialogue flow, `claimOrigin`, `::origin` / `::originreset` |

One core touch (sanctioned by server/AGENTS.md rule 2): `MOBILE_CLIENT_ATTRIBUTE`
added to `getCoreApi()` (`PluginManager.ts`) and the `PluginCoreApi` interface
(`PluginTypes.ts`), so plugins can detect mobile clients without requiring
core modules directly.

## The six origins

All kits are deliberately modest — bronze/iron basics, food, a few coins, and
one or two cosmetic/thematic flavor items. No power creep: the journey is the
game. Kit slots range 11–13; a full inventory silently skips what it cannot
hold (`adds()` no-ops on full — new accounts always have space).

| Origin | City | Kingdom | Spawn (x, y, z) | Verification |
| --- | --- | --- | --- | --- |
| Asgarnia | Falador | asgarnia | 2964, 3378, 0 | "Standard: Falador" teleport destination, `plugins/interface/TeleportInterface.plugin.js` |
| Misthalin | Varrock | misthalin | 3213, 3424, 0 | "Standard: Varrock" teleport destination, same file |
| Kandarin | Ardougne | kandarin | 2661, 3301, 0 | "Standard: Ardougne" teleport destination, same file |
| Morytania | Darkmeyer | morytania | 3605, 3365, 0 | Interpolated: inside Darkmeyer's bank square between verified NPC spawns — Bankers (3603–3607, 3369), Vyrewatch Sentinel (3605, 3360), Noctillion Lugosi (3608, 3363) — `data/definitions/npc-spawns.json`; Darkmeyer ground-item tiles nearby |
| Keldagrim | Keldagrim | keldagrim | 2857, 10166, 0 | Interpolated: between two verified Dwarf NPC spawns (2854, 10164) and (2861, 10167), `data/definitions/npc-spawns.json`; inside the Keldagrim territory rect from `kingdoms/Areas.Kingdoms.js` |
| Wanderer | Edgeville | — | 3089, 3524, 0 | The world spawn, `data/definitions/world.json` — the exact tile every new account appears on today |

Kits (base for everyone: bronze axe, bronze pickaxe, tinderbox, small fishing
net, bronze dagger, bucket, pot, 3 bread, 25 coins):

- **Asgarnia:** + bronze sword, wooden shield, red cape (Falador militia colors), 2 bread — the recruit's kit.
- **Misthalin:** + 25 coins (50 total), 2 bread — the market city pays a little better.
- **Kandarin:** + 2 silk (Ardougne trade good), 15 coins (40 total), 2 bread.
- **Morytania:** + 3 garlic, 1 stake — you know what walks Darkmeyer after dark.
- **Keldagrim:** + bronze warhammer, 3 beer, 25 coins (50 total) — company-town wages, properly spent.
- **Wanderer:** + rope, 2 cooked meat — the survival kit.

Each origin also carries a one-paragraph **lens** (in `Data.Origins.js`): who
you are and the word on the street, written from the world bible — the regency
and the Kinshra arming for Asgarnia, the heirless crown and the gangs for
Misthalin, the unexposed plague lie for Kandarin, the blood tithe and the
Salve clock for Morytania (flavored as a native under the vyre heel —
Darkmeyer is hostile to outsiders), the company war and the Red Axe for
Keldagrim, and the road itself for the Wanderer. The lens is shown as a
statement dialogue right before the claim, so the choice is informed.

## UX decision

**No client creation screen exists** — the client is the game UI; accounts are
created at login. **Tutorial Island is disabled** (`world.json`
`disabledPlugins`), so a brand-new account spawns at the Edgeville world spawn
(3089, 3524 — Jon's own spawn point) with an empty inventory. The choice is
therefore an in-game dialogue on first login.

Two constraints shaped the trigger:

1. `OptionDialogue` supports at most **5 options** (the engine's chatbox
   interface list), so 6 origins need two pages: the four surface powers, then
   Keldagrim / Wanderer / back.
2. Desktop logins land on the **welcome screen** first — the gameframe
   bootstrap only arrives when Play is clicked — so a chatbox dialogue started
   at `onPlayerLogin` would be clobbered by the welcome screen's root swap.
   Desktop players are prompted from the welcome screen's Play button (the
   same pattern TutorialIsland uses); mobile clients skip the welcome screen,
   so they are prompted from a login microtask instead.

Flow: intro statement ("Every life begins somewhere…") → page 1 (4 powers +
"More homes…") → page 2 (Keldagrim, Wanderer, back) → lens statement →
"Claim X as my home" / "Choose again".

**Tradeoffs / edge cases:**

- **Wanderer is the skip.** There is no dismiss-to-Wanderer: closing the
  dialogue by other means leaves the choice unmade and the prompt returns on
  the next login. Skipping *is* an explicit, one-click option.
- **Existing players get prompted once** on their first login after this
  ships (they never chose). Picking a home teleports them to its spawn and
  grants the kit — their explicit choice, but it moves them mid-session.
- **Wilderness logins** skip the welcome screen, so the Play-button trigger
  never fires that session; the prompt returns on the next login, and
  `::origin` opens the choice manually any time.
- **Bots are excluded** (`isPlayerBot` guard, same as the welcome screen).
- The dialogue is **chatbox UI, not a custom interface** — no cache widget
  work, works on the stock client today.

## Player state

Persisted attributes (kebab-case, namespaced):

- `origin:id` — the chosen origin id (`asgarnia` | `misthalin` | `kandarin` | `morytania` | `keldagrim` | `wanderer`)
- `kingdom:id` — set through the kingdoms plugin's own `joinKingdom` helper,
  which emits `kingdom:rank-granted` → rank `Subject`. Home is initial
  citizenship; the player rises within the hierarchy from there. The Wanderer
  sets no kingdom.

Commands: `::origin` (everyone) shows your home, or opens the choice if you
have none; `::originreset <player>` (OWNER) clears `origin:id` so the prompt
returns on next login — the dev/testing escape hatch.

## Event catalog

- `origins:selected` `{ player, originId }` — emitted after attributes, kit,
  and spawn are applied. **No listener in v1**; reserved for the
  starting-experience system (footing + ambient rumor).

## What's stubbed for later

- **Deeper Mount & Blade-style background questions** — the v1 pick is home
  only. Childhood / trade / reason-for-leaving question chains are a later
  expansion; the dialogue flow is built to extend (page functions are
  independent chains).
- **Origin-gated content** — nothing yet reads `origin:id` except this
  plugin. Future hooks: origin-specific rumors, starting-experience footing,
  kingdom courts reacting to a native vs. an outsider, Morytania hostility
  toward non-native players.
- **Re-picking a home** — one choice, no take-backs (owner reset only). A
  legitimate in-world reason to change home (exile, defection questline) is
  content to design.
- **Spawn safety** — Darkmeyer and Keldagrim spawns are interpolated between
  verified adjacent NPC spawns, not stood-on tiles. Confirm in-game before any
  logic depends on the exact tile (e.g. an aggressive Vyrewatch patrol
  overlapping the Darkmeyer spawn).
- **Starting-experience system** — `origins:selected` is emitted; the
  consumer (footing, ambient rumor, first-hour guidance) is the next build.
