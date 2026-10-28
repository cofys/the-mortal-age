# Pet conversations

## Scope and evidence

Import the canonical Pet-dialogue export, NPC index and source-type index byte for byte. The source branch adds the omitted official Pet category; all3,285 installed conversations remain semantically equal. Use cache241 identities, canonical Wiki transcript section slugs and the actual active follower. Do not infer ownership or unlocks from source text.

## Production path

Native NPC option -> NPC interaction dispatcher -> Pets.handlePetClick/interact -> pets:interact -> Dialogue.Pets -> npc-dialogue:start -> NpcDialogues exact indexed page/variant -> existing dialogue chain/random/condition/choice runner -> normal client dialogue packets. Pet ownership, physical item and save state remain owned by Pets; conversation selection stores no new durable state.

## Implementation

1. Canonical source PR: collect80 Pet transcripts, preserve source types separately, migrate cross-listed references, generate twice and preserve existing records. Independent source review before publication.
2. TSPS import and native conversation PR: explicitly select an owned follower's ordinary standard section; exclude overhead, item-use, foreign-owner and conditional branches. Match multi-form standard sections against cache display names; if ambiguous, retain the existing safe no-op pending a separately evidenced selector. Leave cat Interact menus and puppy actions intact.
3. Correct the shared exact-start API to validate both requested page and variant, including flat records. Regression tests must reject a nonexistent flat variant and a wrong page rather than falling back.
4. Real Player/NPC/native interaction tests, physical metamorphosis/pickup/drop, dialogue random branches, refusal and save/relog. Independently challenge selection/underlying shared runner. Build, targeted and full suites; actual rendering client walkthrough. Freeze hashes, review, then publish separate ready PR.
5. Stop only this worktree's services and clear its slot. Choose another unclaimed progress section after this Pets round.

## Limits

No invented transcript lines, no guessed quest-state conditions, no POH arena overhead playback and no active Clues changes. Pet-source work does not implement Barbarian Assault, hard-mode raid dust acquisition or every species-specific interaction. Record any unresolved branch rather than calling the whole Pets section complete.
