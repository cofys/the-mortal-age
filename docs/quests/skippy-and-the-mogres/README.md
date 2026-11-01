---
quest: Skippy and the Mogres
key: skippy_and_the_mogres
status: passed
tested: 2026-10-31
tester: agent
model: deepseek-v4.1-flash
commit: 391f331b178033fe603ff138accd3fd39ce48eb6
cache: osrs-241_2026-10-20
start: fresh
travel: travel_to
---

# Skippy and the Mogres

Quest Helper's five-step route (Sober-Up with the bucket, nettle tea, hangover cure)
advanced varbit 1344 exactly as it expects, and the cache contract (row 135, endstate 3)
agreed at every stage. The run spawned the tea and cure rather than making them; those
recipes belong to GhostsAhoy and PlagueCity and were not re-tested here.

## Findings

- **open** The wiki transcript has no Sober-Up wording for the damp or hungover forms, so
  the option is swallowed there rather than guessed. Live OSRS behaviour is unrecorded.

## Runs

### 2026-10-31 agent deepseek-v4.1-flash

- **Start:** fresh account, placed at Skippy with `::tele 2983 3196 0` (the only teleport).
- **Route:** `::item` bucket of water; Sober-Up → "Throw the water!" (varbit 0→1, NPC
  2587→2588); `::item` nettle tea and use on Skippy (1→2, 2588→2589); `::item` hangover
  cure and use on Skippy (2→3, 2589→2590). Quest Helper named each guide step in turn and
  reported `helperStatus: complete`; `contract.agrees` was true at stages 0, 1, 2 and 3.
- **Dialogue:** fresh Talk-to plays the `before-skippy-and-the-mogres` variant and leaves
  the stage at 0; after completion Talk-to plays `after-skippy-and-the-mogres` and Sober-Up
  plays its right-click variant. The stage-1 and stage-2 Talk-to branches and both
  hangover-cure-recipe options matched the transcript.
- **Relog:** stage 3 persisted and the post-quest dialogue still played after logging out
  and back in.
- **Not checked:** making the nettle tea or cure in-game, the moving-Skippy refusal, the
  quest journal and completion scroll on a real client, travel to the NPC, and the Mogres
  Slayer task being offered once the quest is complete.
