# Myreque Reputation Track — Design

What comes after "In Search of the Myreque": the player proved themselves to
the Hollow (and the regime learned their face). Now Morytania's powder keg
gets personal.

## The needle

One axis, `myreque:standing`, -1000..+1000. Positive = the Myreque,
negative = Drakan's regime. Every deed moves the one needle, so helping one
side *is* hurting the other. No fence-sitting is possible by construction.

| Standing | Tier | Side |
|---|---|---|
| +600..+1000 | Sworn of the Hollow | Myreque |
| +200..+599 | Hollow-Trusted | Myreque |
| +1..+199 | Whisper-Friend | leans Myreque |
| 0 | Unremarkable | — |
| -1..-199 | Watched | leans Drakan |
| -200..-599 | Tithe-Favored | Drakan |
| -600..-1000 | Oathbound of the Blood | Drakan |

Tier doors lock: at Hollow-Trusted+ the regime's content shuts (the fence
won't deal, Polmafi won't talk); at Tithe-Favored and below the Hollow
shuts. Turning coat means grinding the needle back across — and the world
remembers (`myreque:turncoat-at`, citizen gossip, cold lines both sides).

The track opens after completing "In Search of the Myreque". Before that,
the tithe-officer still takes your coin (the tithe is just taxes until you
know better) but it caps at -199.

## Earning it (all diegetic — NPCs, objects, no ::commands)

**Myreque (+):**
- *Smuggle supplies* — hidden cache crates by the old tunnel (Mort Myre).
  Deliver 5 bread / 5 swamp paste / 3 planks → +40. 10-min cooldown.
  Discoverable via the fence, Polmafi, and a street rumor.
- *Hide operatives* — during patrol pressure, an exposed runner spawns on
  the south road. Talk them into the tunnel before the timer runs out → +80.
  If caught: rumor + tension.
- *Sabotage* — burn the tithe records (chest by the officer, needs a
  tinderbox) → +120, 2h world cooldown, Sarev accuses. Killing Vost the
  Tithe-Taker in the Sunken Hollow → +100 (+150 if the captive is saved).
- *Spread word* — at Hollow-Trusted, the fence gives you a sealed note to
  carry to Polmafi → +60. 15-min cooldown.

**Drakan (−):**
- *Inform* — tell Sarev what you know of the Hollow → −120, 1,000 coins.
  30-min cooldown. Defecting from Trusted+ pays −150 / 1,200.
- *Pay the tithe* — 1,000 coins → −25. 10-min cooldown.
- *Hunt Myreque* — a courier runs the swamp road. Kill him → −60; report
  to Sarev → another −80 and 1,500 coins.

## Tiers with teeth

- **Hollow-Trusted (+200):** the fence trades (discount garlic/stakes,
  premium blood-rune buy), courier runs unlock, the worn silver sickle
  token, "How do I stand?" prose.
- **Sworn of the Hollow (+600):** title in dialogue, patrol-evasion
  instincts (the warning before Canifis), citizens react with fear;
  vyre patrols in Canifis hunt you on sight.
- **Tithe-Favored (−200):** better inform rates, tithe stipend, the tithe
  brand token; the Hollow's doors close (caches empty, Polmafi refuses).
- **Oathbound of the Blood (−600):** patrol immunity in Canifis, bounty
  work, title; the Sunken Hollow tunnel refuses you ("Not you. Never
  you.").

## Consequences

- **Canifis patrol zone** (3450–3540, 3440–3520): three vyrewatch patrols.
  At +200 they hunt you; at −600 they salute and let you pass.
- **The swamp/Hollow:** at −200 Polmafi and the fence shut you out; the
  operative event never spawns for you.
- **Citizens:** tier crossings seed citizen gossip ("X runs with the
  Myreque now") so Canifis reacts with fear/hostility through the memory
  system; realm rumors fire; tension nudges Morytania's hottest border.

## Integration

- `kingdom:rumor` on crossings and deeds; new `Rumors.Arrival` pool lines
  gated on `morytania:myreque-sworn-walks` /
  `morytania:drakan-oathbound-walks` (headcounts in KingdomStore).
- Tension +2 on reaching Sworn/Oathbound (the regime blames foreign
  meddlers / the purge is emboldened); +1 when a runner is caught.
- SunkenHollow emits `myreque:vost-slain`; its tunnel and Polmafi honor
  the locks.

## Files

- `Reputation.Myreque.js` — the needle, tiers, crossings, quest gate.
- `Actors.Myreque.js` — spawns (officer, fence, courier, caches, tithe
  chest) and every earning action.
- `Danger.Myreque.js` — patrol zone, swamp zone, operative event.
- `Commands.Myreque.js` — dev-only `::myreque` (DEVELOPER rank).
- Token items in `data/definitions/custom-items.json` (50001 worn silver
  sickle, 50002 tithe brand), each with a Read action for the diegetic
  standing readout.
