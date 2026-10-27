# Chompy chick acquisition

The user requests Pets tracker work after Explorer ring1407. Fix this bounded verified
gap first; keep Claude's clue/Bloodhound and Leagues work untouched.

Wiki Chompy chick requires the elite Western Provinces diary AND claimed rewards;
both killing and plucking roll1/500. Current generated chompy_bird.entries already
contains13071 at1/500 with the diary note. No dumper or generated export change needed.
Actual bugs: Pets requires an obsolete flag never set by real diary claiming; successful
plucks never roll the existing pet entry. Existing kill rolls already use NpcDrops.

Replace the pet metadata flag with a generic requiredDiaryReward descriptor. A new
read-only diary:is-reward-claimed query answers from the canonical claimed-tier service.
Pets' generic pets:eligible query and central award gate use that descriptor, denying
missing/unknown service responses and ignoring the old synthetic flag.

Big Chompy Bird Hunting emits chompy:plucked only after a successful owned-carcass
pluck. Track a set of corpse identities per player so killing another bird does not
invalidate an earlier unplucked corpse. Before consuming, require an exact recorded carcass, its owner and a live,
registered nonbusy player. A full bag retains the carcass for retry. Delete the record
before emitting so duplicate/stale/foreign clicks cannot grant more meat or rolls.
Also require matching private area, plane and adjacency; remove only the consumed identity.

Acquisition.Pets.js listens to the successful pluck event, consumes each owned NPC
identity once, asks eligibility, then invokes npc-drops:roll-table with an entryFilter
for the chick. This preserves the configured500 denominator and normal chance rules;
it does not roll bones/meat/feathers again. Send rolled pets through existing
npc-drops:roll, preserving ownership, duplicates, collection log and reclaim behavior.
No hand-coded probability and no new kill roll, so kills are not doubled.

Tests use real Player/NPC/Inventory, real diary claimTier, actual quest toad release,
NPC death and native pluck where possible. Cover incomplete/complete-unclaimed/claimed,
old flag denial, both sources, nonwinning roll, duplicate/foreign/full-bag/dead/retry,
full bag with active follower, ownership/relogin and repeat pluck. Build, full suite,
own-server walkthrough, independent Codex review/re-review and separate ready PR.
Stop services; live checkout and Claude worktrees remain untouched.

RSProx indexes live/dead Chompy IDs1475/1476 (Pluck op4) but no player actions on
those gamevals; Wiki and cache, not a capture, determine this missing reward behavior.
