# Amulet of blood fury

## Inventory creation and recharging

The [Blood shard transcript](https://oldschool.runescape.wiki/w/Transcript:Blood_shard)
sets the dialogue and consumption rules for using a blood shard on an amulet:

- Creation shows two item-box warnings (irreversible shard consumption and the
  untradeable result), then offers Yes/No. Accepting consumes one shard and turns
  the existing fury into a blood fury with 10,000 charges. Declining preserves both.
- Recharging asks whether to use the shard. Accepting consumes **one** shard and
  adds up to 10,000 charges, even when more shards are carried.
- Above 20,000 charges, accepting first shows an item-box warning about the
  30,000 cap and a separate “Recharge anyway?” choice. Declining either choice
  preserves the shard and amulet. Accepting the second choice consumes one shard
  and fills the remaining capacity, wasting the excess.
- At 30,000 charges the action reports that the amulet is already at maximum
  capacity and consumes nothing. Successful creation/recharging uses an item box;
  recharging reports the actual charges added and the resulting total.

The [amulet page](https://oldschool.runescape.wiki/w/Amulet_of_blood_fury)
also specifies the 10,000 starting charges and 30,000 cap. These pages were checked
on 27 October 2026. No indexed rsprox recordings were available for blood-shard or
blood-fury inventory actions, so these changes rely on the Wiki transcript rather
than captured packet timing, animation, sound or varbit evidence.

The previous handler consumed multiple shards immediately and refused top-ups
with less than 10,000 free capacity. The handler now follows the choices above and
rechecks the actual amulet identity, ownership, charge count and available shard
before consumption. Changed ingredients invalidate the pending choice.

## Melee charge use and healing

The amulet page specifies a 20% chance to heal 30% of damage dealt by melee,
one charge per successful melee hit (including separate hits in a multi-hit
attack), and reversion to a normal fury when exhausted.

The old combat-method wrapper delegated hit construction to the underlying melee
method. Its pending hits therefore retained the base method, bypassing the
wrapper's after-hit callback. Ordinary melee could deal damage without spending
charges or rolling the healing effect. The effect now listens to the existing
resolved-hit event, checks the hit's melee type and the worn amulet, and spends
one charge on each damaging hitsplat. The heal is rolled and calculated when each
hitsplat lands (`HitDamage.onApplied`) from the HP actually removed, so damage
queued earlier in the same cycle and overkill never heal. It preserves the 20%
roll, 30% rounded-down heal, charge exhaustion and normal-fury reversion.

## Validation

Regression coverage invokes the registered inventory handlers and real dialogue
entries: creation acceptance/decline, one-shard recharging, 20,000/20,001/25,000/
29,999/30,000 boundaries, both cancellation branches, changed ingredients, reversed
item order, Check/Revert, ordinary melee event dispatch, multiple damaging hits,
exhaustion and the exclusion of magic/ranged hits and inventory-only amulets.

In-game verification covered creation warnings and cancellation, creation at 10,000,
recharge cancellation, separate top-ups to 20,000 and 30,000, refusal at full
capacity, and the waste-warning path after ordinary melee combat spent charges.
Both declining and accepting the final waste warning were checked, including the
remaining shard count and Check's resulting 30,000 charges.

## Scope and evidence gaps

Bank Configure-Charges/automatic withdrawal charging is a separate bank interaction,
documented by the [Configure-Charges page](https://oldschool.runescape.wiki/w/Configure-Charges),
and is not implemented here. PvP death conversion belongs to the death system and
was not changed or verified by this change.

The amulet page lists a four-tick creation recipe, but the transcript does not
establish a post-confirmation delay. Without a recording establishing that timing,
this change makes no claim about matching creation packet timing. Check and Revert behavior is preserved; their uncaptured
feedback is not
claimed to match live packets. Healing probability is checked deterministically
in regression coverage; in-game melee verification checks actual charge loss.
