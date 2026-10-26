# Wilderness ditch jump sound

The ordinary **Cross** interaction sends sound 2462 with a client delay of 25,
matching [rsprox captures](https://rsprox.net/database), recording **345** (revision
230, southbound crossing clicked at recording tick 124). The sound accompanies
`wild_ditch_jump`; the aggregate has the same delay on six crossings across five
recordings. The previous plugin sent this sound with delay 0.

Cache revision 241 confirms `ditch_wilderness_cover` is object 23271 with **Cross**,
`wild_ditch_jump` is sequence 6132, and sound-effects archive 2462 exists (205 bytes).
The plugin reuses the existing named sound ID and sets the delay at the interaction.

Validation:

- `node --test server/tests/wilderness-ditch.test.cjs`: four tests pass. Before the
  fix, the two successful-crossing tests failed with delay 0 instead of 25; the
  active-movement and click-cooldown rejection checks passed.
- Own-worktree agent MCP: teleported a test player to (3139, 3523, 0), then used
  the real object 23271 at (3139, 3521), **Cross**, and waited four ticks. Before:
  sound 2462, delay 0, landing (3139, 3520, 0). After: the same sound and landing,
  delay 25. The return crossing also sends delay 25 and lands at (3139, 3523, 0).
- MCP does not expose sounds, so temporary instrumentation recorded calls to
  `PacketSender.sendSoundEffect` as test messages. That instrumentation was removed.

This verifies the server's sound scheduling, not perceived audio or animation in a
real client. Movement timing and Wilderness warning behaviour are outside this fix.
No generated data changed.
