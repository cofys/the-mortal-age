# The Bastard of Varrock — questline outline

> The flagship Misthalin storyline for The Mortal Age. Additive custom content;
> no canon files touched. Game state: ~2017 OSRS, post-Regicide. Roald III sits
> the throne of Varrock, aging, with **no named heir anywhere in canon**. The
> gods are silent. The Church rivals the monarchy. The Shield of Arrav quest is
> completable and its certificate economy still runs.

## Premise (locked)

Forty years ago, Prince Roald was secretly wed to **Elspeth**, a Varrock
seamstress, by a young **Father Lawrence**. When the old king found out, the
marriage was struck from every record and the girl sent away — but there was a
child. A son. The Church buried it. The boy would be about thirty now, living
somewhere under an assumed name. Nobody — not the palace, not the Church, not
the gangs — knows exactly who or where he is when our story starts.

Story flags (kingdom store, `misthalin` record):

| Flag | Meaning | Set by |
| --- | --- | --- |
| `misthalin:bastard-son-hidden` | The claim has not surfaced publicly | seed (`true`) |
| `misthalin:succession-rumors` | Rumors of a bastard son circulate in Varrock | Q1 completion (`true`) |
| `misthalin:bastard-proof-held` | The player holds proof of the birth | Q3 completion (`true`) |
| `misthalin:claim-surfaced` | The claim is public; the powers are moving | Q4 start (`true`) |
| Q4 ending flags (`misthalin:church-ascendant`, `misthalin:gang-puppet-king`, `misthalin:palace-purge`, `misthalin:succession-crisis`) | one set by the player's choice | Q4 completion |

The hidden flag stays `true` until Q4: a rumor is not a claim. The Church, the
gangs and the palace only *move* — visibly, in the world — once the claim
surfaces. Until then they watch, buy records, and bury things quietly.

## Quest 1 — "The Heirless Crown" (BUILT)

*Requirements: none. Stages: 5 (0–4). Reward: 1 QP, 500 Prayer XP.*

1. **Rumor.** The Blue Moon Inn bartender (Varrock) lays out the succession
   vacuum: no heir, a frail king, a nervous city. He points at old Father
   Lawrence, who "needs to confess before Saradomin takes him."
2. **Confession.** Father Lawrence (church east of the palace) confesses the
   secret wedding and the son — then a palace guardsman walks in and Lawrence
   clams up.
3. **The watchers.** Confront a palace guard inside Varrock Palace. He warns
   you off, but lets slip that *both gangs are buying old church records*.
4. **The name.** Back to Lawrence: the mother was **Elspeth**; if any proof
   survived, it's in the palace library's royal registry (Reldo keeps the keys).
   Completion flips `misthalin:succession-rumors` → `true`.

Canon safety: Lawrence lives (Romeo & Juliet untouched); the marriage is
pre-crown and annulled, so nothing in the ~2017 state contradicts it; the son
is nameless and locationless — Q2/Q3's MacGuffin, not a retcon.

## Quest 2 — "The Paper Trail" (investigation)

*Requirements: The Heirless Crown.*

The player hunts the surviving record: the monastery's birth ledgers, Reldo's
palace library, and the gangs — **Phoenix vs Black Arm as rival info brokers**.
Both gangs are buying the same papers; the player can buy from one, play them
against each other, or steal. Key choice: which gang gets your coin (sets a
`bastard-of-varrock:gang-favor` attribute — Phoenix or Black Arm — that changes
prices, access and dialogue in Q3).

Ends on a half-answer: the registry page naming the child is found, but the
name has been **torn out** — and the tear is fresh. Someone got there first.
The question of *who tore it* drives Q3.

## Quest 3 — "Blood Will Tell" (proof)

*Requirements: The Paper Trail.*

Two threads converge:

- **The torn half.** The missing half of the registry page is in gang hands —
  whichever gang the player crossed in Q2 holds it; the other will sell it (at
  a price set by the favor attribute). Reuniting the page names the son.
- **The Shield of Arrav as legitimacy token.** The gangs' reading of old law:
  whoever holds the *reunited* Shield speaks with the king's voice — the one
  object the court can't dismiss. (Soft requirement: completing Shield of Arrav
  first opens a cleaner path through the gang negotiations, but the proof
  itself doesn't require it.)

Completes with the player holding proof and knowing the claimant's identity —
and every power suddenly very interested in the player. Sets
`misthalin:bastard-proof-held` → `true`.

## Quest 4 — "The Bastard of Varrock" (reveal & fallout)

*Requirements: Blood Will Tell.*

The claim surfaces. All three powers move at once, and the player picks who
to back — four endings, each flipping kingdom flags and paying out
differently:

1. **Back the Church** — the claim is denounced as forgery from the pulpit;
   Lawrence is disgraced or worse. `misthalin:church-ascendant` → `true`.
   The Church's grip on Varrock tightens visibly afterward.
2. **Back a gang** (Phoenix or Black Arm, by Q2 favor) — the claimant is
   installed as a puppet; the gang becomes the power behind the throne.
   `misthalin:gang-puppet-king` → `true`. Street-level Varrock changes hands.
3. **Back the palace** — the claimant disappears; the secret guard handles it.
   `misthalin:bastard-son-hidden` stays `true`. The player is rewarded with
   `kingdom:rank-granted` (Misthalin, Man-at-arms) — the crown pays its debts.
4. **Expose it publicly** — the claim is shouted in the square with proof in
   hand. Succession crisis: `misthalin:succession-crisis` → `"open"`, Roald
   forced to name an heir under pressure. The messiest ending, and the one
   that reshapes the most world state.

Q4 is the quest that earns `kingdom:ruler-changed` (endings 2 and 4, if the
throne actually changes hands) — the event the kingdom system was built to
carry.

## Recurring cast & systems notes

- **Reldo** (palace librarian) becomes the Q2 gatekeeper; his Shield of Arrav
  role makes him the natural keeper of the royal registry.
- **Baraek** (fur trader, Phoenix-adjacent) and **Charlie the Tramp**
  (Black Arm-adjacent) are the street-level info brokers; Katrine and Straven
  are the gang leadership the player graduates to in Q3.
- **The palace secret guard** ("the captain") is the through-line antagonist —
  named and faced in Q4, never before.
- Reframed ambient dialogue (`VarrockPolitics.plugin.js`) keeps the
  succession vacuum audible in Varrock from minute one: guards, the priest,
  the bartender, and the brokers all mutter about it, quest or no quest.
- Design rule for the whole arc: every quest must leave the world able to
  answer "what changed?" — a flag, a rumor tier, a moved NPC — never just a
  journal entry.
