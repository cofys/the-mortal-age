# Farming resource priority over Tangleroot delivery

The Wiki Tangleroot page says incoming Farming resources, including Hespori seeds, take priority over the pet. The Pets event handler delivers synchronously, but Farming emits the pet event before its seed reward, allowing the pet to take the final inventory slot first.

1. Reproduce the one-slot conflict using real Farming and Pets handlers, a real inventory and an existing follower. Verify both-slot delivery, losing seed rolls, opt-out and Hespori's own pet roll.
2. Resolve the seed reward before emitting the existing pet event, keeping the event eligible for disabled seeds and Hespori. Do not edit the Pets implementation or independently change rates/capacity policy.
3. Build, run integration regressions plus existing Farming/Pets checks, obtain independent review and a separate PR. Include it in the final combined full-suite verification.

Source: https://oldschool.runescape.wiki/w/Tangleroot (resource precedence and Probita recovery).
