# Ring of suffering

Inventory charging accepts unnoted and noted rings of recoil in either use order.
Each successful use consumes one recoil ring and adds 40 charges, retaining the
suffering ring's imbue variant. Its existing capacity is 100,000 charges.
A successful charge also resets the player's shared ordinary ring-of-recoil damage
counter to zero, giving the next ordinary recoil ring its full 40 damage points.
A refused charge consumes nothing and leaves that counter unchanged.

The [OSRS Wiki ring of recoil page](https://oldschool.runescape.wiki/w/Ring_of_recoil)
explicitly describes the per-player counter and its reset when charging a ring of
suffering. The [ring of suffering page](https://oldschool.runescape.wiki/w/Ring_of_suffering)
establishes noted/unnoted acceptance, 40 charges per ring, the 100,000-charge cap,
toggleable recoil and loss of stored rings on discharge. Both pages were checked
on 25 October 2026. There are no indexed rsprox recordings of these item actions;
no recording is cited as evidence for this change.

Cache revision 241 identifies ordinary recoil as 2550 and its note as 2551.
The suffering pairs are 19550/20655, 19710/20657, 25246/25248 and 26761/26762.
The note id comes from the recoil definition, rather than an assumed adjacent id.
27129/27130 are bank placeholders, not another wearable imbue pair.

Regression coverage exercises the registered interaction hooks and inventory
containers: both use orders and recoil forms, every wearable imbue variant,
topping up, exact cap, full-ring refusal, and rejection of noted suffering rings
and unrelated jewellery. The old implementation leaves a partially used ordinary
recoil counter unchanged and ignores noted recoil inputs.

In-game checks reproduced noted-ring refusal before the fix. Afterward, a
three-ring note stack became two and an uncharged ring became (r) with 40 charges.
A later combat check spent four ordinary recoil damage points. After relogging,
charging the suffering ring raised its balance from 40 to 80 and reset the shared
counter from four to zero; the resulting save retained both changes. Infinite
health was enabled for that combat check. This verifies recoil state, not combat
damage balance.

Existing saved charge metadata remains readable. Mutating charges migrates it to
the namespaced key; regression checks cover top-up, spending, discharge and item
cloning without losing the stored balance.

The existing one-ring-per-use flow remains. Without a recording, exact charging
menu packets, bulk quantity selection, message wording and tick timing cannot be
established from these Wiki pages. Bank Configure-Charges is a separate bank
withdrawal interaction and is not validated here. Ordinary recoil Break/Check
options belong to the ordinary ring interaction, outside this inventory charging
path. Recoil settings UI and its packet layout have no indexed capture either.
