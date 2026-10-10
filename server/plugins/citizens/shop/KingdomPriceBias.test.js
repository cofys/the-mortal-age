"use strict";
// Kingdom-choice phase 2: kingdom-aligned shop price bias.
// - Home-kingdom player: 0.95x ("home discount")
// - Foreign player: 1.08x ("foreign price")
// - Wanderer (no kingdom:id): 1.0x (list, no note)
// Stacks multiplicatively with the memory loyalty discount.

const {
  kingdomPriceBias,
  KINGDOM_HOME_BIAS,
  KINGDOM_FOREIGN_BIAS,
} = require("./MerchantShops");

const mkPlayer = (kingdomId) => ({
  getAttribute: (key) => (key === "kingdom:id" ? kingdomId : undefined),
});
const mkMerchant = (kingdomId) => ({
  getAttribute: (key) => (key === "kingdom:id" ? kingdomId : undefined),
  getUsername: () => "TestMerchant",
});

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}`);
  }
}

// Bias constants match Jon's calls.
check("home bias is 0.95", KINGDOM_HOME_BIAS === 0.95);
check("foreign bias is 1.08", KINGDOM_FOREIGN_BIAS === 1.08);

// Home: player and merchant share a kingdom.
{
  const r = kingdomPriceBias(mkPlayer("misthalin"), mkMerchant("misthalin"));
  check("home mult 0.95", r.mult === 0.95);
  check("home note", r.note === "home discount");
}

// Foreign: different kingdoms.
{
  const r = kingdomPriceBias(mkPlayer("asgarnia"), mkMerchant("misthalin"));
  check("foreign mult 1.08", r.mult === 1.08);
  check("foreign note", r.note === "foreign price");
}

// Wanderer: null kingdom -> list, no note.
{
  const r = kingdomPriceBias(mkPlayer(null), mkMerchant("misthalin"));
  check("wanderer mult 1.0", r.mult === 1.0);
  check("wanderer no note", r.note === null);
}

// Wanderer: undefined kingdom -> list, no note.
{
  const r = kingdomPriceBias(mkPlayer(undefined), mkMerchant("misthalin"));
  check("undefined kingdom mult 1.0", r.mult === 1.0);
  check("undefined kingdom no note", r.note === null);
}

// Wanderer must NOT be mispriced as home when merchant is in the
// default-fallback kingdom (kingdomIdOf falls back to KINGDOM_IDS[0]).
{
  const r = kingdomPriceBias(mkPlayer(null), mkMerchant("asgarnia"));
  check("wanderer vs fallback-kingdom merchant still 1.0", r.mult === 1.0);
}

// Ordering: home < wanderer < foreign for the same list price.
{
  const list = 1000;
  const home = Math.round(list * kingdomPriceBias(mkPlayer("misthalin"), mkMerchant("misthalin")).mult);
  const wanderer = Math.round(list * kingdomPriceBias(mkPlayer(null), mkMerchant("misthalin")).mult);
  const foreign = Math.round(list * kingdomPriceBias(mkPlayer("kandarin"), mkMerchant("misthalin")).mult);
  check("price(home) < price(wanderer)", home < wanderer);
  check("price(wanderer) < price(foreign)", wanderer < foreign);
  check("home price is 950", home === 950);
  check("wanderer price is 1000", wanderer === 1000);
  check("foreign price is 1080", foreign === 1080);
}

// Stacking: final = list x memory x kingdom bias.
{
  const list = 1000;
  const memoryMult = 0.9; // loyalty discount
  const kb = kingdomPriceBias(mkPlayer("misthalin"), mkMerchant("misthalin"));
  const stacked = Math.round(list * memoryMult * kb.mult);
  check("stacked = 1000 * 0.9 * 0.95 = 855", stacked === 855);
}

console.log(`KingdomPriceBias.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
