# Poison and venom task lifecycle

24 October 2026 audit of the progress tracker's Status effects task 4.

Previously, logout cancelled player tasks before taking the save snapshot, and
the poison task's stop method cured the affliction. Loading an afflicted save
restored its fields without resuming damage. Registered actors at zero HP could
also receive another poison hit.

Callback cancellation is now separate from curing. Each actor has one current
poison-task owner, resumed after login and explicitly suspended before logout
saving. Explicit cures, death and natural expiry terminate the affliction;
stale/replaced or unregistered callbacks cannot damage or erase a newer effect.
Protection alone is not an explicit cure; that separate application/effect
contract is outside this lifecycle correction. Save schema and existing damage
progression remain unchanged, with NPC immunity/cadence corrections in #930.

Independent review also found `State.PlayerBots.resetMovementState` cancelling
all player-keyed tasks while the player remains registered. Status tasks now
have distinct keys and explicit logout suspension. Ordinary activity cancellation
retains both affliction and its existing countdown.

Primary rules: [Poison](https://oldschool.runescape.wiki/w/Poison) and
[Venom](https://oldschool.runescape.wiki/w/Venom), retrieved 24 October 2026.
The tracker explicitly requires persisted affliction and orb state across relog
and no delayed status damage after departure/death. This change preserves the
existing saved severity contract; it does not infer a new logout damage reset or
claim to recover the exact residual timer phase from public evidence.

Four lifecycle regressions and the activity-cancellation regression were observed
failing before their respective corrections. Fresh TypeScript build, 56 focused
checks and all 4,925 server tests pass, with no failures or skips. Independent
review cleared the complete delta, including the private task key and explicit
logout suspension.

An isolated slot-24 server also verified actual headless login/logout, SQLite
saves, and the damage loop through the existing owner-only `poisonme` command.
Ordinary poison orb severity 30 survived logout/login and became 29 after the
restored task's next hit. A debug-applied venom orb of 1,000,003 survived relog and
became 1,000,004 after its next hit. The latter starts at the debug command's
12-damage test severity; it does not change normal venom application rules.
The QA server saved and stopped cleanly. Live installation is separate and must
preserve the latest main and Claude client assets.
