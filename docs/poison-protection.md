# Poison protection and existing afflictions

Poison immunity prevents a new poison or venom affliction. It does not itself cure an existing affliction. The [Serpentine helm](https://oldschool.runescape.wiki/w/Serpentine_helm) explicitly protects its wearer without curing preexisting poison or venom (checked 24 October 2026).

`CombatFactory.poisonEntity` retains the immunity check for new applications. `CombatPoisonEffect` continues its existing countdown and damage progression when protection is granted, including the helm's short immunity refresh. Explicit cure actions clear the affliction fields; the effect task then stops on its next execution. The hitpoints orb continues to show the active affliction ahead of immunity.

The correction removes only the immunity-as-cure check. Task ownership, logout/death handling, damage intervals, interface behavior, immunity duration, potion/food effects and Lunar cure mechanics are separate concerns and are unchanged.

## Validation

After a fresh TypeScript build, run:

```sh
node --test tests/poison-orb.test.cjs tests/serpentine-helm.test.cjs
```

The added regressions use real registered players and real task ticks. They exercise actual charged-helm upkeep for both poison and venom, protection granted halfway through the existing countdown, explicit cure cancellation, and rejection of new afflictions. Before the correction, the four preservation cases failed because immunity cleared the affliction and stopped its task. All 15 focused checks pass after the correction.
