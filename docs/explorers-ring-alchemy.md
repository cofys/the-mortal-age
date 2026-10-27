# Explorer's ring free alchemy

Wiki Explorer's ring4 supplies30 rune-free Low/High casts, 21/55Magic, noXP,
ordinary spellbook rune-payment preference and the item-on-ring warning. Rings1-3
are Low only. The shared allowance and login-only midnight reset come from #1365.

Cache241 provides lumbridge_alchemy483, low/high1/2, Close4, dynamic inventory7,
charges8; scripts1460/1462/1464 draw inventory93, selected-high bit5398 and used
counter4554. Settings struct3815 is setting432, driven by inventory-warning-disabled
bit2179. No indexed RSProx actions exist for lumbridge_alchemy; opening order and
warning text are implementation choices. Ordinary casting effects retain existing
alchemy.md capture evidence. No generated definitions were edited.

The ring opens the native panel on named gameframe side3. Low/High selection persists;
lower tiers cannot authorize High. Close returns the inventory panel. Native item
clicks, worn Alchemy, Functions/Alchemy and item-on-ring use the common casting path.
Complete ordinary rune payments take precedence; insufficient supplies are untouched
when the ring pays. All ring-funded casts give zeroXP. Only dedicated ring inputs
bypass the normal spellbook requirement. Item-on-ring warns by default; native
All Settings432 flips and saves the warning preference.

Core changes are generic: api.core.castAlchemy accepts a spell name/id and opaque
source; magic:alchemy-payment supplies complete-rune availability and validation,
commit, XP/book/tab controls. Core contains no ring rules. Queues and confirmations
keep exact item identity and source. Ring sessions additionally check registration,
life/status, owned ring object, panel and logout generation. A real Inventory clone
checks coin capacity after exact-slot deletion. Failed/overflow/stale actions do not
consume charges. The old fake diary fixture now checks unknown subop20 rather than
expecting the now-supported Alchemy subop to be absent; native regressions cover it.

Fifteen new real-object tests use Player/Inventory/PacketSender/ClientConnection with
all plugins loaded, native inventory/panel/settings/item-use/dialogue input. They
cover paid/free/noXP, partial supplies, worn rings, tiers/levels/books, charge30,
ring-self denial, full coin stack, metadata copies, stale panels/rings/targets,
queued rejection and success, confirmation/cancellation/logout, and a real PlayerSave
restored into a fresh Player. The focused alchemy/daily/diary/settings group passes45/45.
Independent Codex review asked for real confirmations, metadata, successful queues
and fresh-save tests; all added and re-reviewed clear.

Native own-slot8 MCP: Functions/Alchemy opened483 on161:79; High turned a bronze
dagger into6coins with counter4554=1 and MagicXP unchanged at13,034,431. Relog retained
counter1 and selected-high5398=1. Low then added4coins, counter2, XP unchanged; Close
restored149. The QA account's startup modal was closed before the feature walkthrough.
Only an isolated new QA profile was used. The server saved and stopped and its ports
3108/43708/49808 closed. Offline client VM sweep483: no errors, item0 or null text.
Full-suite results are recorded in the PR.

Full suite on frozen production code: 9,052/9,052 passed, no failures/skips (498s).
The final strengthened worn-option assertion uses native equipment387:24 op4, the
cache's third worn option, and is rechecked in the focused suite after the full run.

## Replacement-stack review (27 October2026)

The real bank transfer path emptied a stack by mutating its Item, then refilled that
same empty object. Retained-reference guards therefore accepted replacement arrows.
ItemContainer.add now clones new contents into an empty stack slot; live stack merges
retain their identity. Existing queued and confirmed target guards remain unchanged.
Two real-object native regressions reproduce bank open/deposit/withdraw/close during
a queued item-on-ring cast, and inventory removal/refill during confirmation. Both
failed before the change (charges2vs1 and1vs0), then passed. Normal stack merging is
also checked. Fresh build/focused84/84 and independent Codex review clear; final
full suite9,124/9,124 passes without failures/skips (373 seconds). No service or live game was started for this
follow-up; the regression uses real Bank/Inventory/Player/ClientConnection paths.
