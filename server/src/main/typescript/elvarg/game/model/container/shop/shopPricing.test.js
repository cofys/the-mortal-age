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
