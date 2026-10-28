# Pets owner/form dialogue selector repair

Scope: route the canonical owner-only hatchling sections and both Dark core forms through actual native Talk-to. Existing ownership and exact-page policy stays authoritative. This is one dialogue selector issue; other missing source bindings, conditional skilling conversations and acquisition producers remain separately tracked.

Expected behavior: the owner's Prime/Supreme hatchling uses the owner branch, never other-player/menagerie text. Dark core and Corporeal Critter use their respective Pet-prefixed source sections despite cache display names omitting Pet. Sources are official Wiki transcript pages, pinned cache241 and active definitions. Exact gameval RSProx searches core_pet/supreme_pet find no recorded actions, so no recording/timing parity claim.

Path: native NPC option -> Pets current-owned follower validation -> pets:interact -> Dialogue.Pets selects exactly one canonical page/variant -> npc-dialogue:start exact mode -> NpcDialogues actual DialogueManager -> native continue packets. Morph uses the current definition and invalidates the old dialogue; save/login retains the current descriptor through existing Pets persistence. No generated data, core/client or Claude clue changes.

Plan: native RED owner/form tests; adjust selector only; real morph+stale continuation, foreign/removed ownership, pickup/bank/fresh-login checks; build/focused/full; independent Codex trace and adversarial shared-system check; rendered client; push separate ready PR; stop own helpers/release slot.

## Verification

The two added native reproductions failed before the selector repair (8 unchanged passes,2 failures), then passed. Final focused suite97/97 includes real native packet dispatch, current-form morph and stale continuation, foreign/removal guards, native pickup, actual Bank deposit/withdraw, PlayerSave and fresh login. Only transport is captured.

Independent Codex review inspected unchanged native option/ownership/current-definition, DialogueManager and active-descriptor persistence. Its separate adversarial checks acquired Supreme/Dark core through actual npc-drops:roll, kept28 real inventory slots full, saved the active Critter/owner hatchling, freshly logged in, verified native conversations and reverse Critter morph without touching physical inventory:2/2. Shared Pets/Puppies/dialogue foundations86/86. Initial reviewer scratch count included other owned nonpet NPCs; corrected assertion to isPet(), with no gameplay edit. No actionable findings in inspected paths.

Frozen build base65b090bd8216f7a248e5b7f12c68955920720863; tsc --build passed. Dialogue.Pets SHA25648B211EF10161CD02CDAD5AAD891079C83A2A121094C4A3C6526CB47FED3FC71; native test9BBDA152737AE309EB782E15E4B0680258FEE96BB4E892E87B04B1239BF20CB2. JS source loads dynamically through actual PluginManager. Source unchanged during independent/full checks.

Rendered browser verification: seeded only disposable item/location setup. Native inventory Drop summoned Dark core318; MCP opened initial Talk-to, native continue displayed the next line and chat message for the core's head-shake narration. Native world menu Metamorphosis changed the same follower into Critter8010 and closed the prior conversation; native Critter Talk-to displayed its own text and portrait. After real MCP pickup/relogin, native inventory Drop and NPC Talk-to on Supreme6628 displayed the owner branch; native continue displayed its matching hatchling response/portrait. One QA tab closed during a viewport resize; account was restored through normal login and that path repeated. Screenshots/state retained locally. Prime is covered through real native test paths, not a separate rendered screenshot. Exact official animation/timing for head shake and rare/conditional other species remain unverified and are outside this selector change.

Own QA server/client/browser/MCP helpers stopped,3107/43707/49807/9229 closed in a fresh listener query; own slot7 cleared. No live game or Claude changes. Dependency-copy fallback completed and is no longer running.

## Independent-review lifetime correction (supersedes earlier freeze)

A second independent adversarial transition found an existing generic-routing bypass: native Yami pickup queues its NPC removal, another pet is summoned, then a stale Talk-to click still resolves the old registered NPC. Pets.interact returned false on the wrong current pointer and generic NpcDialogues started the old transcript. Diagnostics confirmed the exact old World slot, pending removal and Yami text while Smol was current; no mocked NPC replacement/index reuse.

Both dialogue branches now consume actions on known actual pet NPCs whose current pointer, owner, registration or removal state is invalid, before action dispatch/fallthrough. Ordinary nonpet world NPCs with the same definition ID retain generic handlers. No shared core or generic dialogue edit. Separate owner-branch regression failed12pass/1fail before the guard, then final focused98/98 passes. The earlier97-case evidence remains preliminary. Current source hashes: Pets542EFC842848955B5C3314C0B1E39533A4092D1EDB4179627A04C50EB52CD612; Dialogue48B211EF10161CD02CDAD5AAD891079C83A2A121094C4A3C6526CB47FED3FC71; test1C34761A8A9381E3F6ABA383ABB75FA916DD1352FB83C3F37345778CE6AA4949.

The first full run hit Windows sandbox temporary rename EPERM in persistence tests. It is retained as a failed environment run. A second run with a dedicated writable workspace TMP/TEMP was stopped after the new guard finding; neither is claimed as final success. The final guard build runs the complete suite again with that writable temporary directory. Rendering above predates the guard; final source will be checked in the rendering client again before posting.

## Final evidence

Final product remained frozen at the three guard hashes above. Independent guard re-review ran2/2 native stale/ordinary-nonpet controls and86/86 foundations on this exact branch. Final focused98/98 and complete suite9496/9496, zero failures/skips/cancellations, exit0 (559783.8462ms). Normal localhost socket access and dedicated workspace TMP/TEMP were required: unchanged network suite37/38 with sandbox connect EACCES versus38/38 with local access. No network or persistence code changed to obtain the passing run.

The exact committed owner product abf51fbaa was restarted in its real client after the guard: normal relog restored Supreme, MCP opened owner Talk-to, native Continue showed the matching owner reply/portrait. Both QA processes/tab stopped again; ports3107/43707/49807/9229 closed and own slot7 released.

The full logs include existing omitted-startup AdventurePaths fixture Hunter/WarpedSceptre hook warnings. A separate actual AdventurePaths run compiled exact base65b090bd8 versions of both changed production modules in the worker (each loaded:1, base SHA256fbad648f66a2255175d15bd5b477de5a5591116e4e148a2e70248db31183dcc5 and5c09a45ab15caa5abfae5ced02a9ee02114211a47873f705ac5e0e89c39a2038), reproduced those same warnings, and passed27/27. Initial preload probes missed the loaded modules and were not used as baseline proof. Real Pets regression and independent suites emit startup and have no such hook failures. No unrelated fixture repair is included.
