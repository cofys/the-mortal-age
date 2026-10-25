# Poison's held interface hit

The current [Poison](https://oldschool.runescape.wiki/w/Poison) page (retrieved
24 October 2026) says interfaces withhold damage and decay, then release a hit
after closing. Previously, the shared poison/venom task returned before advancing
its countdown, so a sufficiently long interface still postpones that hit by
another interval after closing.

Bounded correction: advance the existing countdown while a blocking interface
is open, saturating it at zero. Do not damage, decay ordinary poison, escalate
venom, or accumulate multiple overdue hits during the interface. Closing after
the deadline releases one hit and starts the next ordinary interval. Repeated
short interface changes must not stop elapsed time. Preserve NPC behavior and
explicit cure routes. The current interface suppression already
applies to both afflictions; this change retains that eligibility.

Three timing regression groups failed against upstream before correction. Real
Task.tick tests cover ordinary poison and venom, early close/reopen, repeated
toggles, one-hit debt, explicit-cure and NPC controls. Fresh build, 45 focused
checks and all 4,923 server tests pass, without failures or skips. Independent
review cleared the delta and reran all five new tests successfully.

On the isolated slot-27 server, real bank interfaces held both QA players at
99 HP for 40 ticks without decay/escalation. After the queued close was processed,
one ordinary-poison hit reduced HP to 93; one debug-applied 12-damage venom hit
reduced HP to 87. Both were visible within three server ticks of enqueueing close,
with no catch-up burst. Unit tests establish the first eligible task execution;
the server check also includes input-queue and hit-queue processing. The venom
test uses the existing owner-only debug command, not a new normal starting value.
The QA server saved and stopped cleanly. Local installation remains separate.

This PR does not change the normal interval's existing counter implementation;
the separately published #930 corrects its 31-versus-30-tick boundary. It also
does not change logout ownership (#948), UI eligibility, or antipoison immunity
timer pausing. Those are separate contracts, not claims made by this correction.
