// shopPricing curve checks — pure math, no server.
// From server/: node -r ts-node/register/transpile-only \
//   src/main/typescript/elvarg/game/model/container/shop/shopPricing.test.js
const assert = require("node:assert/strict");
const {
    scarcityPriceMultiplier,
    SCARCITY_MAX_MARKUP,
    OVERSTOCK_PRICE_FLOOR,
} = require("./shopPricing");

function close(actual, expected, msg) {
    assert.ok(
        Math.abs(actual - expected) < 1e-9,
        `${msg}: expected ${expected}, got ${actual}`
    );
}

// Full stock -> base price.
close(scarcityPriceMultiplier(100, 100), 1, "full stock");
// Half stock -> 2x.
close(scarcityPriceMultiplier(50, 100), 2, "half stock");
// Quarter stock -> 2.5x.
close(scarcityPriceMultiplier(25, 100), 2.5, "quarter stock");
// Empty -> capped at 3x, never above.
close(scarcityPriceMultiplier(0, 100), SCARCITY_MAX_MARKUP, "empty stock");
assert.ok(
    scarcityPriceMultiplier(1, 10000) <= SCARCITY_MAX_MARKUP,
    "near-empty huge stock stays capped"
);
// Overstock -> discount, asymptotic to the 0.5 floor.
close(scarcityPriceMultiplier(200, 100), 1 / 1.5, "2x overstock");
close(scarcityPriceMultiplier(300, 100), OVERSTOCK_PRICE_FLOOR, "3x overstock hits floor");
assert.ok(
    scarcityPriceMultiplier(100000, 100) >= OVERSTOCK_PRICE_FLOOR,
    "massive overstock never below floor"
);
// No original-stock record (player sold-ins) -> base price untouched.
close(scarcityPriceMultiplier(5, 0), 1, "no max record");
close(scarcityPriceMultiplier(0, 0), 1, "zero max");
// Curve is continuous at the full-stock boundary.
close(scarcityPriceMultiplier(100, 100), 1, "boundary from below");
assert.ok(scarcityPriceMultiplier(101, 100) < 1, "just over full discounts slightly");

console.log("shopPricing.test.js: all assertions passed");

// ---- Kingdom price bias (kingdom-choice) ----
const {
    kingdomPriceBias,
    KINGDOM_HOME_BIAS,
    KINGDOM_FOREIGN_BIAS,
} = require("./shopPricing");

// Home kingdom -> 0.95x discount.
close(kingdomPriceBias("misthalin", "misthalin"), KINGDOM_HOME_BIAS, "home bias");
close(KINGDOM_HOME_BIAS, 0.95, "home is 5% off");
// Foreign kingdom -> 1.08x premium.
close(kingdomPriceBias("asgarnia", "misthalin"), KINGDOM_FOREIGN_BIAS, "foreign bias");
close(KINGDOM_FOREIGN_BIAS, 1.08, "foreign is 8% up");
// Wanderer (no kingdom:id) -> list price, never mispriced.
close(kingdomPriceBias(null, "misthalin"), 1, "wanderer pays list");
close(kingdomPriceBias("", "misthalin"), 1, "empty kingdom pays list");
close(kingdomPriceBias(undefined, "misthalin"), 1, "undefined kingdom pays list");
// Shop with no kingdom (outside great powers) -> neutral for everyone.
close(kingdomPriceBias("misthalin", null), 1, "kingdomless shop neutral");
close(kingdomPriceBias("asgarnia", null), 1, "kingdomless shop neutral for foreigner");
close(kingdomPriceBias(null, null), 1, "both null neutral");
// Ordering: home < wanderer < foreign (same item, same shop).
const home = kingdomPriceBias("misthalin", "misthalin");
const wanderer = kingdomPriceBias(null, "misthalin");
const foreign = kingdomPriceBias("kandarin", "misthalin");
assert.ok(home < wanderer, "home < wanderer");
assert.ok(wanderer < foreign, "wanderer < foreign");
// Stacks multiplicatively with scarcity: final = base x scarcity x bias.
const base = 100;
const scarcity = scarcityPriceMultiplier(50, 100); // 2x at half stock
const homePrice = Math.floor(base * scarcity * home);
const wandererPrice = Math.floor(base * scarcity * wanderer);
const foreignPrice = Math.floor(base * scarcity * foreign);
assert.ok(homePrice < wandererPrice, "stacked: home < wanderer");
assert.ok(wandererPrice < foreignPrice, "stacked: wanderer < foreign");
assert.strictEqual(homePrice, 190, "home: 100 x 2 x 0.95 = 190");
assert.strictEqual(wandererPrice, 200, "wanderer: 100 x 2 x 1.0 = 200");
assert.strictEqual(foreignPrice, 216, "foreign: 100 x 2 x 1.08 = 216");

console.log("shopPricing.test.js: kingdom bias assertions passed");
