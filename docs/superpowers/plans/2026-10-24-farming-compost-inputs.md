# Compost-bin ingredient eligibility

The Wiki Compost Bin page explicitly rejects noted inputs, lists cotton bolls as ordinary compost and half coconuts as supercompost. Existing name-based matching accepts noted produce/potions and omits both listed unnoted products.

1. Reproduce five regression groups: cotton bolls, half coconuts, their mixture, noted produce and a noted compost potion. Verify both bin capacities and existing tiers/exclusions.
2. Check cache note metadata before any used-item path can consume an item. Add the two documented ingredients to the canonical compost sets.
3. Build, run focused/model tests and the full server suite, obtain independent review and publish a separate PR from upstream main.

Source: https://oldschool.runescape.wiki/w/Compost_bin . Verified cache IDs are cotton boll 31460 and half coconut 5976. Timer discrepancies and automatic harvest/compost actions remain separate; no generated data changes.
