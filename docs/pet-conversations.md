# Owned follower conversations

## Canonical data

The source exporter previously omitted Category:Pet dialogue. Source PR https://github.com/RSPSApp/osrsreboxed-db/pull/20 at de353b9ef143caf544b50efc8d290a2598918edf adds80 official Pet transcripts and an additive top-level source-type index. The three imported files are byte-for-byte canonical exports. All3,285 existing runtime records remain semantically equal.

The canonical index also links15 previously unindexed kitten, overgrown and hellcat follower IDs to the two existing A Tail of Two Cats chore sections. This is index availability, not a new quest interaction or an eligibility decision. The original participant, cache241 identities and existing quest selector establish the narrow mapping. All prior index rows remain intact.

## Production path and state owners

Native NPC option -> NetworkBuilder world-action cancellation -> NPCOptionPacketListener owner/private-area/range/current-definition checks -> PluginManager specific NPC hook -> Pets.handlePetClick/interact -> pets:interact -> Dialogue.Pets -> npc-dialogue:start -> NpcDialogues indexed exact page/variant -> existing dialogue chain, random alternatives and MultiChatboxPrompt -> standard chatbox packets.

Pets owns the active follower pointer, physical-form item, morph unlocks, family ownership and save/relog restoration. Dialogue selection adds no saved state and neither awards nor consumes a pet item. The shared runner owns dialogue continuation; MultiChatboxPrompt owns a one-shot219 menu tied to the current chatbox and invalidates it on a later world action.

An NPC can transform in place: getId/current definition change while getDefinition retains its original definition. The selector uses getCurrentDefinition(player), which the independent review's actual native metamorphosis reproduction proved necessary.

## Selection and limits

Only canonical `pet` pages that actually index this NPC ID are candidates. The active owned, registered, visible follower must match the player's current pointer. An explicit uniquely matching standard form section wins; a single generic standard section can be used when no separate form section requires a selector. Ambiguous or absent mappings remain silent. Source types never establish quest eligibility.

Olmlet's six standard sections cover eight physical forms; Enraged Tektiny and Flying Vespina share Tektiny/Vespina sections. All six Theatre pet forms select their respective standard sections. Menagerie overheads, item-use responses and unrelated quest-page candidates are not ordinary conversations. Cats keep their existing Interact menus; puppies retain their own interaction handler. Species-specific conditional variants that need additional selectors remain outside this change.

The generic exact-start API accepts the existing `{page, variant}` choice shape and verifies both values. A nonexistent flat-record variant must not silently play the default. Ordinary dialogue fallback behaviour for callers that do not request exact selection remains unchanged.

## Verification evidence

- Real cache241, map, Player, NPC, Inventory, Bank, PlayerSave, DialogueManager, ClientConnection, all plugins and startup hooks; only network output captured.
- Eight native regression tests cover Olmlet's four-option menu/answer, eight physical Olmlet forms, six Theatre forms, three controlled Puppadile random outcomes, exact-page/variant refusal and flat-record success, pickup/real Bank transfer/fresh saved login, foreign ownership and actual metamorphosis with stale-menu replay denial.
- Focused shared dialogue/Pets/cat/puppy/persistence suites:108/108. The Pet plus all-quest-selector integration suite passes194/194 after the canonical cat-identity repair.
- The independent reviewer chose the in-place metamorphosis/menu transition. It failed because transformed Puppadile still spoke as Olmlet; current-definition selection made the same preserved test pass1/1. Their unchanged shared foundations pass77/77. Source and import reviewers also verified original records, index deltas and exact bytes.
- Original full run9468/9469 exposed the missing cat quest candidates; the canonical regression failed for all15 before the binding and passes after regeneration. Final full rerun is recorded in the PR's Testing section.
- Local RSProx index: NPC7520 appears in139 recordings but has no recorded player actions; NPC8337 appears in53 recordings, with recorded metamorphosis refusals but no Talk-to wording. Conversation structure/text comes from the official Wiki transcript sources. No official random weights or dialogue timing are claimed from these recordings.

## Real rendering client

On an isolated slot7 world, seeded one Olmlet on disposable `pettalkqa`, then used the native inventory Drop, world Talk-to, Continue and four-choice menu. Portrait, name, selected answer and wrapping rendered correctly; the answer returned to the same four options. Native item Use-on consumed one metamorphic dust and showed the unlock confirmation. Native Metamorphosis changed the same NPC index522 from7520/Olmlet to8201/Puppadile; native Talk-to then displayed Puppadile's own player line, portrait and NPC response. The inventory remained empty and follower item varp448 changed20851 ->22376; packed follower varp447 changed492831242 ->537461258.

Local screenshots and state captures are retained under the task's `.runtime/pet-talk-*` files. The item and dust were seeded; menu selection, answer return, Use-on, transformation and Talk-to were actual rendering-client inputs. Controlled RNG is confined to unit tests, not this browser walkthrough.

The QA server saved and shut down through gameUpdate; its client tree was verified by port/command ancestry and stopped. The temporary browser tab and MCP helper were closed, ports3107/43707/49807 were confirmed free and this worktree's slot7 reservation was cleared. The live game and other agents' services were untouched.
