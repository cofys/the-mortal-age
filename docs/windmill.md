# Windmill: using grain on the hopper

Using ordinary, unnoted grain on a windmill hopper must use the same filling
logic as its **Fill** option. Previously only sweetcorn had an item-on-object
handler: grain fell through `UseItemPacketListener` to "Nothing interesting
happens.", even when the hopper was already full.

The fix adds a named Grain → Hopper hook, reusing `fillHopper`. The item-id
guard excludes quest items also named Grain; the hook excludes banknotes.
No generated data changes are needed.

## Evidence

The [OSRS Wiki's making flour guide](https://oldschool.runescape.wiki/w/Money_making_guide/Making_flour)
explicitly describes using grain on the hopper and then operating the controls,
one grain at a time. The [windmill page](https://oldschool.runescape.wiki/w/Windmill)
describes the milling and flour-collection process.

[rsprox captures](https://rsprox.net/database), recording **3181**, revision 232,
normal world, support these facts (checked with both `facts` and `trace`):

| Action | Recorded result |
| --- | --- |
| Fill `hopper1`, clicks at ticks 1796 and 2167 | Consumes one grain and reports that it was placed in the hopper and the nearby lever should be pulled. |
| Fill the occupied hopper, click at tick 1914 | "There is already grain in the hopper." |
| Use `grain` on the occupied hopper, click at tick 1947 | The same refusal at +0 ticks; no grain consumption is reported. |

The successful **use-item** path is supported by the Wiki, not a successful
use-item attempt in this recording. Its successful **Fill** attempts confirm
the existing handler's inventory/message contract. This change does not claim
to reproduce the captured animation, sound or tick timing.

The active revision-241 cache confirms `hopper1` = 24961 (Hopper, Fill),
`hopperlevers1` = 24964 (Hopper controls, Operate), and ordinary grain = 1947.
Tests use the existing cache-derived identifiers and assert the hopper gamevals.

## Validation

- `yarn build` passed.
- `node --test tests/windmill.test.cjs`: before the fix, three grain-use tests
  failed and the rejection test passed; after the fix, all four passed. These
  dispatch through the real PluginManager with cache definitions and a real
  Player inventory. They cover empty/full hoppers, Fill followed by Use,
  controls followed by another fill, noted/quest grain, unrelated targets,
  and preserving an existing sweetcorn load.
- `node --test --test-name-pattern='RFD Sir Amik cornflour' tests/quest-plugins.test.cjs`:
  the existing cornflour recipe regression passed.
- The dedicated worktree was started with `AGENT_MCP=1 yarn start` on its
  assigned ports (client 3177, game 43777, MCP 49877). MCP could not bind:
  `EADDRINUSE 127.0.0.1:49877`. Windows lists 49788–49887 as an excluded TCP
  range; an independent bind also failed with no Linux listener. No port
  override was used. **Live MCP reproduction and visual verification remain
  blocked/unperformed.** The full test suite was not run.

## Manual check

Take two ordinary grain to Mill Lane Mill north-west of Lumbridge and climb
to the hopper. Use one grain on it: one grain should be consumed. Use the
second before operating the controls: the full-hopper refusal should appear
and the grain should remain. Operate the controls and use the remaining grain:
it should now be accepted. The hopper's Fill option should still work.

## Separate findings, not fixed here

Recording 3181 also includes filling/operating animations, sounds, lever
transforms and increasing `mill_flour` values. The existing windmill handler
does not implement all of these responses and sends a boolean flour varbit.
Those need separate cache/behavior investigation; this patch only fixes
grain-use dispatch. Cabbage-picking evidence was too weak to select that
candidate (one attempt without a clear completed pick).
