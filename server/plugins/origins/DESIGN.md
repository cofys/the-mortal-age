# ORIGIN SELECTION — Design (v1)

The Mortal Age's Mount & Blade-style home pick: at character creation the
player chooses a HOME from the five great powers (or wanders). The pick is the
"feels like home" anchor — starting location, starting kit, and the initial
political lens. The `origins:selected` event is the seam the
starting-experience system hooks for footing + ambient rumor.

## Files

`server/plugins/origins/`

| File | Role |
| --- | --- |
| `Origins.plugin.js` | Registration list (attach-only `register`); wires Selection's triggers to Gui's screen |
| `Data.Origins.js` | The six origins: ids, spawns, kits, lens text; kit AND GUI icon keys validated against `ItemIdentifiers` at startup. Each origin also carries `icon` (realm-card emblem) and `epithet` (one-line card flavor) |
| `Selection.Origins.js` | Login/Play-button/679-close triggers, the chatbox fallback flow, `claimOrigin`, `::origin` / `::originreset` |
| `Gui.Origins.js` | The graphical creation screen: custom widget group 30012, server-driven selection state, click handling. Implements "The Mortal Age UI template" below |

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
(3089, 3524 — Jon's own spawn point) with an empty inventory.

The choice is now a graphical ceremony, one screen, in this order:

1. **Appearance** — the existing makeover-style customizer (interface 679)
   for new accounts, unchanged.
2. **Home** — the new creation GUI (custom widget group 30012, `Gui.Origins.js`),
   opened when 679 closes. One screen: six realm cards + the selected origin's
   lens + a claim button. Claiming reuses the exact same `claimOrigin` path
   (attributes, kingdom, kit, spawn, `origins:selected`).

The chatbox flow from v1 is kept as the **fallback until the GUI is verified
in-game**: mobile clients still use it, dismissing the GUI without choosing
falls back to it, and any GUI open failure falls back to it. Triggers that
open the GUI live in `Selection.Origins.js` (`onWelcomePlay`,
`onInterfaceClosed` for 679, `::origin`); the login fallback timer waits
while 679 or the GUI is open instead of racing them.

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

## The Mortal Age UI template

Jon's directive: the creation screen must be *really special* — it is the
player's first impression — and its visual language becomes the template for
**all** future custom UI. "Belong" = native to this world: the gods are
silent, the great powers are stirring, every life begins somewhere. Somber,
mythic, grounded. Not generic fantasy chrome, not default OSRS skin, not
modern-minimalist web UI.

The creation GUI (`Gui.Origins.js`, group 30012) is the reference
implementation. Hold every future screen to these decisions.

### Palette

| Token | Hex | Use |
| --- | --- | --- |
| `TMA_PANEL` | `#14100b` | Panel background — warm near-black |
| `TMA_PANEL_INNER` | `#1e1812` | Inset panels (detail pane) — one step lighter |
| `TMA_CARD` | `#241c13` | Realm card background |
| `TMA_CARD_HOVER` | `#2e2417` | Card hover (`mouseOverColor`) |
| `TMA_GOLD_DIM` | `#6b5a3a` | Borders, hairline rules — aged bronze |
| `TMA_GOLD` | `#c9a227` | Selection glow, bright borders — the "chosen" signal |
| `TMA_GOLD_TEXT` | `#d9b45b` | Headings |
| `TMA_PARCHMENT` | `#e8ded0` | Body text |
| `TMA_MUTED` | `#9a8f7d` | Secondary text (epithets, subtitles, footnotes) |
| `TMA_BUTTON` | `#3a2c1a` | Button fill |
| `TMA_BUTTON_HOVER` | `#4a3a22` | Button hover |
| `TMA_BUTTON_TEXT` | `#ffd27f` | Button label |

No pure black, no pure white, no saturated colors. Everything sits in the
warm dark range; gold is the only accent and it means *importance* —
selection, headings, the claim action. Never use gold for body text.

### Typography

| Face | fontId | Role |
| --- | --- | --- |
| `q8_full` | 497 | **Display** — titles, the mythic register ("WHERE DO YOU CALL HOME?") |
| `b12_full` | 496 | **Labels** — card names, button text, section headers |
| `p11_full` | 494 | **Body** — lens paragraphs, descriptions, footnotes |

Rules: all text `textShadowed: true`. Headings gold (`TMA_GOLD_TEXT`),
body parchment (`TMA_PARCHMENT`), secondary muted (`TMA_MUTED`).
Centered (`xTextAlignment: 1`) for ceremonial text (titles, card names,
buttons); left-aligned for reading text (lens paragraphs). Inline
`<col=>` is for emphasis inside a line, never as a substitute for the
heading/body/muted roles.

### Borders, panels, spacing

- **Double-rule frame**: outer border in `TMA_GOLD_DIM`, panel inset 2px.
  Frames are quiet — they hold the composition, they don't decorate it.
- **Depth = nested panels**, never drop shadows: void → panel
  (`TMA_PANEL`) → inner (`TMA_PANEL_INNER`) → card (`TMA_CARD`). Canvas
  widgets are flat fills; layering *is* the texture.
- **Selection = gold glow**: a `TMA_GOLD` rectangle 2px larger behind the
  selected card, toggled with `sendInterfaceDisplayState`. One selection
  signal, always the same.
- **Hairline rules** (`TMA_GOLD_DIM`, 1px) separate title from content and
  header from body inside panes — never box everything.
- **Hover** always lightens the fill (`mouseOverColor`); never change the
  text color on hover.
- **Cards**: border (`TMA_GOLD_DIM`) → face (`TMA_CARD`, the clickable
  layer) with 2px inset. The *entire* card face is clickable — every visible
  part (icon, name, city, epithet) carries the action, so the card feels
  like one button.
- Spacing rhythm on the 700×460 creation modal: 24px outer margins,
  8px card gaps, content vertically centered in its band. Generous
  whitespace; the screen should breathe like a temple, not a spreadsheet.

### Buttons

Dark bronze fill (`TMA_BUTTON`), 2px bright-gold border (`TMA_GOLD`
frame rect behind, button inset 2px), gold bold label (`TMA_BUTTON_TEXT`,
`b12_full`, centered both axes), hover lightens the fill
(`TMA_BUTTON_HOVER`). Labels are verbs of commitment: "CLAIM ASGARNIA AS
MY HOME", "TAKE TO THE ROAD" — never "OK"/"Submit".

### Copy voice

Second person, present tense. The world is old and tired; the player is new.
Rumor is always attributed ("Word on the street: …"). The Wanderer is never
a lesser choice — "no home" is framed as freedom, not absence.

### What this template does NOT cover (phase 2)

- **Appearance step rebuild.** The 679 customizer is still the default OSRS
  skin. Phase 2 rebuilds it in this template (the 3D preview needs a client
  runtime extension — per `docs/agents/interfaces.md`, the missing
  capability belongs in the runtime as a declared option, not in this
  plugin).
- **Realm card art.** Cards currently use thematic item sprites (red cape,
  coins, silk, garlic, beer, rope). A proper sigil/banner sprite set per
  origin would elevate them.
- **Mobile verification.** Mobile clients keep the chatbox flow until the
  GUI is verified on the 601 toplevel.
- **Sound.** A low drum or choir sting on open would sell the "moment";
  the client has jingle hooks (`PLAY_JINGLE`).
- **Deeper background questions** (already stubbed in "What's stubbed for
  later" below).

### The creation screen layout (reference)

700×460 modal, centered. Title (`q8_full`, gold) + subtitle (muted) +
gold hairline rule. Below: 3×2 realm cards (138×132, icon/name/city/epithet)
left, detail pane (210×272: name, demonym·city, rule, wrapped lens,
fealty line) right. Claim button (280×36) centered beneath, footnote muted
at the bottom. Default selection: Asgarnia, so the lens pane is never empty.

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
