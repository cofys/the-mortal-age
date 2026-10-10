"use strict";

/**
 * ShopStockTiers.Economy.test.js — commodity stock tiers in shops.json.
 *
 * Finite-stock economy tuning: no shop entry may be effectively infinite.
 * Tiers (see commit): STAPLE 2,500 / SUPPLY 1,000 / GEAR 250.
 * Plain node, no server. Run: node server/plugins/economy/ShopStockTiers.Economy.test.js
 */

const assert = require("assert");
const path = require("path");

const shops = require(path.join(
    __dirname, "..", "..", "data", "definitions", "shops.json"
));

const STAPLE_CAP = 2500;
const SUPPLY_CAP = 1000;
const GEAR_CAP = 250;

// High-volume authentic staples sold across many shops.
const STAPLE = new Set([554, 555, 556, 557, 558, 559, 314, 313, 882, 884, 877]);
// Tools, armor sets, packs, misc non-consumables.
const GEAR = new Set([
    8794, 8790, 4089, 4091, 4093, 4095, 4097, 1963, 1925, 22846, 22844,
    22838, 13258, 13259, 13260, 13261, 25533, 24851, 12009, 12641,
    24709, 22517,
]);

function capFor(itemId) {
    if (STAPLE.has(itemId)) return STAPLE_CAP;
    if (GEAR.has(itemId)) return GEAR_CAP;
    return SUPPLY_CAP;
}

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`ok - ${name}`);
    } catch (e) {
        failed++;
        console.error(`FAIL: ${name}: ${e.message}`);
    }
}

const entries = [];
for (const shop of shops) {
    for (const e of shop.originalStock || []) {
        entries.push({ shop: shop.id, itemId: e.id, amount: e.amount });
    }
}

test("no effectively-infinite stock (global ceiling 2500)", () => {
    const over = entries.filter((e) => e.amount > STAPLE_CAP);
    assert.strictEqual(
        over.length, 0,
        `entries above ${STAPLE_CAP}: ${JSON.stringify(over.slice(0, 5))}`
    );
});

test("every entry respects its tier cap", () => {
    const viol = entries.filter((e) => e.amount > capFor(e.itemId));
    assert.strictEqual(
        viol.length, 0,
        `tier violations: ${JSON.stringify(viol.slice(0, 5))}`
    );
});

test("headline retierings landed", () => {
    const byId = (id) => entries.filter((e) => e.itemId === id).map((e) => e.amount);
    assert.ok(Math.max(...byId(1931)) <= 2500, "pots capped at 2500 (was 50000)");
    assert.ok(Math.max(...byId(4160)) <= 1000, "broad arrows capped at 1000 (was 50000)");
    for (const id of [31906, 31908, 31910]) {
        assert.ok(Math.max(...byId(id)) <= 1000, `cannonball custom ${id} capped at 1000`);
    }
    for (const id of [556, 555, 557, 554]) {
        assert.ok(Math.max(...byId(id)) <= 2500, `elemental rune ${id} capped at 2500`);
    }
});

test("restockTicks still present on commodity entries", () => {
    // The tuning must not have dropped restock metadata.
    for (const shop of shops) {
        for (const e of shop.originalStock || []) {
            if (e.amount >= 1000) {
                assert.ok(
                    Number.isInteger(e.restockTicks),
                    `shop ${shop.id} item ${e.id}: missing restockTicks`
                );
            }
        }
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
