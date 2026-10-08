// CitizenTailors unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  hashStr,
  tailorTypeFor,
  workshopFor,
  styleFor,
  waresFor,
  materialsFor,
  masterpieceFor,
  seasonFor,
  workLineFor,
  styleLineFor,
  hawkLineFor,
  commissionLineFor,
  masterpieceLineFor,
  garmentsFor,
  shouldFire,
  shouldHawk,
  shouldOfferCommission,
  pickOne,
  isRealPlayer,
  withinTiles,
  TAILOR_TYPES,
  WORKSHOPS,
  KINGDOM_COLORS,
  SEASONAL_STYLES,
  CLOTHIER_GARMENTS,
  WEAVER_BOLTS,
  ARMORER_WARES,
  EMBROIDERED_PIECES,
  ANIM_NEEDLEWORK,
  _resetState,
} = require("./CitizenTailors");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

_resetState();

let n = 0;
function check(name, fn) {
  n++;
  try {
    fn();
    console.log(`ok ${n} - ${name}`);
  } catch (e) {
    console.error(`not ok ${n} - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

// 1. Hash stability across calls.
check("hashStr is deterministic", () => {
  assert.equal(hashStr("tailor|cofy"), hashStr("tailor|cofy"));
  assert.notEqual(hashStr("tailor|cofy"), hashStr("tailor|jon"));
});

// 2. tailorTypeFor returns a known type or null, stable across restarts.
check("tailorTypeFor stable and bounded", () => {
  for (let i = 0; i < 200; i++) {
    const t = tailorTypeFor("user" + i);
    assert.ok(t === null || TAILOR_TYPES.includes(t), `bad type: ${t}`);
    assert.equal(tailorTypeFor("user" + i), tailorTypeFor("USER" + i)); // lowercased
  }
  const tailors = Array.from({ length: 200 }, (_, i) => tailorTypeFor("user" + i)).filter(Boolean);
  assert.ok(tailors.length > 40 && tailors.length < 120, `expected ~35% tailors, got ${tailors.length}`);
  for (const t of TAILOR_TYPES) {
    assert.ok(tailors.includes(t), `type never assigned: ${t}`);
  }
});

// 3. Non-tailors are the majority; nulls on bad input.
check("tailorTypeFor rejects bad input", () => {
  assert.equal(tailorTypeFor(null), null);
  assert.equal(tailorTypeFor(""), null);
});

// 4. Workshops prefer the citizen's kingdom.
check("workshopFor prefers kingdom", () => {
  for (let i = 0; i < 50; i++) {
    const w = workshopFor("ws" + i, "asgarnia", "clothier");
    assert.equal(w.kingdom, "asgarnia");
  }
  // Unknown kingdom falls back to the full pool.
  const w = workshopFor("wsx", "unknownland", "clothier");
  assert.ok(WORKSHOPS.includes(w));
});

// 5. Weaver/armorer workshop preferences hold.
check("workshopFor trade preferences", () => {
  for (let i = 0; i < 50; i++) {
    const w = workshopFor("loom" + i, "misthalin", "weaver");
    assert.ok(["loom", "hall"].includes(w.kind), `weaver got ${w.kind}`);
    const a = workshopFor("pad" + i, "asgarnia", "armorer");
    assert.ok(["forge", "tent"].includes(a.kind), `armorer got ${a.kind}`);
  }
});

// 6. Season styles are seasonal and kingdom-colored.
check("styleFor returns season + colors", () => {
  const summer = styleFor("kandarin", Date.UTC(2026, 6, 15));
  assert.equal(summer.season, "summer");
  assert.ok(SEASONAL_STYLES.summer.includes(summer.style));
  assert.equal(summer.colors, KINGDOM_COLORS.kandarin);
  const winter = styleFor("keldagrim", Date.UTC(2026, 0, 15));
  assert.equal(winter.season, "winter");
  assert.ok(SEASONAL_STYLES.winter.includes(winter.style));
});

// 7. seasonFor mapping.
check("seasonFor months", () => {
  assert.equal(seasonFor(Date.UTC(2026, 3, 1)), "spring");
  assert.equal(seasonFor(Date.UTC(2026, 6, 1)), "summer");
  assert.equal(seasonFor(Date.UTC(2026, 9, 1)), "autumn");
  assert.equal(seasonFor(Date.UTC(2026, 11, 1)), "winter");
});

// 8. Materials always include hides and leather (the hunter tie-in).
check("materialsFor includes hunter materials", () => {
  for (const season of ["spring", "summer", "autumn", "winter"]) {
    const mats = materialsFor(season);
    assert.ok(mats.length > 0);
    assert.ok(mats.includes("cured hides"), `no hides in ${season}`);
    assert.ok(mats.includes("leather"), `no leather in ${season}`);
  }
});

// 9. Wares tables per type.
check("waresFor per type", () => {
  const t = Date.UTC(2026, 6, 15);
  assert.ok(WEAVER_BOLTS.includes(waresFor("w1", "weaver", t)));
  assert.ok(ARMORER_WARES.includes(waresFor("w1", "armorer", t)));
  assert.ok(EMBROIDERED_PIECES.includes(waresFor("w1", "embroiderer", t)));
  assert.ok(CLOTHIER_GARMENTS.includes(waresFor("w1", "clothier", t)));
});

// 10. Masterpieces carry kingdom colors.
check("masterpieceFor has colors", () => {
  const m = masterpieceFor("mp1", "asgarnia", Date.UTC(2026, 6, 15));
  assert.ok(m.includes(KINGDOM_COLORS.asgarnia), m);
  assert.equal(m, masterpieceFor("mp1", "asgarnia", Date.UTC(2026, 6, 15))); // daily stable
});

// 11. Work lines exist for every type.
check("workLineFor covers all types", () => {
  const rng = lcg(42);
  for (const t of TAILOR_TYPES) {
    const line = workLineFor(rng, t);
    assert.ok(typeof line === "string" && line.length > 5, t);
  }
  assert.equal(workLineFor(lcg(1), "not-a-type"), null);
});

// 12. Line builders mention the workshop.
check("style/hawk lines mention workshop", () => {
  const rng = lcg(7);
  const s = styleFor("misthalin", Date.UTC(2026, 6, 15));
  const w = workshopFor("x", "misthalin", "clothier");
  assert.ok(styleLineFor(rng, s, w).includes(w.name));
  assert.ok(hawkLineFor(rng, "woolen broadcloth", w).includes(w.name));
  assert.ok(commissionLineFor(rng, s).length > 10);
  assert.ok(masterpieceLineFor(rng, "a wedding gown in Varrock blue and silver", w).includes("wedding gown"));
});

// 13. Pure gates: cooldown blocks, chance gates.
check("shouldFire/shouldHawk/shouldOfferCommission gates", () => {
  const now = 100_000_000_000;
  assert.equal(shouldFire(lcg(1), now - 1000, now), false); // cooldown
  assert.equal(shouldHawk(lcg(1), now - 1000, now), false);
  assert.equal(shouldOfferCommission(lcg(1), now - 1000, now), false);
  // Long past cooldown, lcg(1) first draw is 0.236 — below all chances.
  assert.equal(shouldFire(lcg(1), 0, now), true);
  assert.equal(shouldHawk(lcg(1), 0, now), true);
  assert.equal(shouldOfferCommission(lcg(1), 0, now), true);
});

// 14. garmentsFor supply hook shape.
check("garmentsFor hook", () => {
  let tailor = null;
  let plain = null;
  for (let i = 0; i < 500 && (!tailor || !plain); i++) {
    const t = tailorTypeFor("hook" + i);
    if (t && !tailor) tailor = "hook" + i;
    if (!t && !plain) plain = "hook" + i;
  }
  assert.ok(tailor, "no tailor found in 500 usernames");
  assert.ok(plain, "no non-tailor found in 500 usernames");
  assert.equal(garmentsFor(plain, "misthalin", Date.UTC(2026, 6, 15)), null);
  const g = garmentsFor(tailor, "kandarin", Date.UTC(2026, 6, 15));
  assert.equal(g.type, tailorTypeFor(tailor));
  assert.ok(g.workshop.length > 3);
  assert.equal(g.season, "summer");
  assert.ok(g.wares.length > 3);
});

// 15. isRealPlayer rejects bots and nulls.
check("isRealPlayer", () => {
  assert.equal(isRealPlayer(null), false);
  assert.equal(isRealPlayer({ isPlayerBot: () => true, getHostAddress: () => "bot", getUsername: () => "x" }), false);
  assert.equal(isRealPlayer({ isPlayerBot: () => false, getHostAddress: () => "127.0.0.1", getUsername: () => "cofy" }), true);
});

// 16. withinTiles Chebyshev, same plane only.
check("withinTiles", () => {
  const mk = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.equal(withinTiles(mk(0, 0, 0), mk(14, 0, 0), 14), true);
  assert.equal(withinTiles(mk(0, 0, 0), mk(15, 0, 0), 14), false);
  assert.equal(withinTiles(mk(0, 0, 0), mk(0, 0, 1), 14), false);
});

// 17. Animation id is the engine-verified needlework anim.
check("anim id sane", () => {
  assert.equal(ANIM_NEEDLEWORK, 885);
});

// 18. pickOne deterministic with injected rng.
check("pickOne", () => {
  const rng = lcg(3);
  assert.equal(pickOne(rng, ["a", "b", "c"]), "a");
});

console.log(`\n${process.exitCode ? "FAILURES" : "ALL PASS"} — ${n} checks`);
