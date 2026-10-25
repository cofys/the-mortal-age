# Antidote protection during interfaces

The [OSRS Wiki Poison article](https://oldschool.runescape.wiki/w/Poison),
checked 24 October 2026, states that the antipoison timer does not count down
while an interface is open. Previously this protection used uninterrupted wall
time, so a bank visit could consume the entire remaining duration.

`SecondsTimer` now supports an optional, idempotent pause policy. Resuming shifts
the start time by the held duration, preserving fractional seconds. Starting or
stopping a timer does not clear that policy: a new duration started while held
stays held until resumed. Timers whose owners never pause them behave as before.

The generic `interface:changed` event runs after `Player.setInterfaceId` assigns
a different id. The existing `interface:closed` notification before replacement
is unchanged. Poison Timer listens to changes and reconciles on login, holding
only the player's poison-immunity timer when `getInterfaceId() > 0`. Switching
between two blocking interfaces remains continuously held; no polling is added.
This uses the existing server blocking-interface definition. It does not change
which client widgets block gameplay.

Persistence continues to save remaining seconds, with no new fields or saved
pause state. Normal logout removes the interface before saving. Other timers,
poison hit scheduling, potion strengths and cure rules are unchanged.

Validation: build, then `node --test tests/antidote-interface-clock.test.cjs
tests/poison-orb.test.cjs tests/consumable-edge-cases.test.cjs`. Regressions use
the real Player setter, plugin handlers, potion effects and save/load path with
a controlled monotonic clock; unrelated timers remain active, and repeated
toggles preserve elapsed fractional time.
