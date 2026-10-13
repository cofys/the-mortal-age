// Run with: node --test server/tests/araxxor-combat.test.cjs
// Pure Araxxor combat math: no server boot needed.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Shared = require("../plugins/bosses/araxxor/Shared.Araxxor");
const Area = require("../plugins/bosses/araxxor/Area.Araxxor");
const Minions = require("../plugins/bosses/araxxor/Minions.Araxxor");

test("lair bounds cover the arena but not the tunnel approach", () => {
  const at = (x, y, z = 0) => ({ getX: () => x, getY: () => y, getZ: () => z });
  assert.equal(Area.insideLair(at(3631, 9812)), true, "boss tile");
  assert.equal(Area.insideLair(at(3643, 9806)), true, "egg tile");
  assert.equal(Area.insideLair(at(3633, 9821)), true, "teleport tile");
  assert.equal(Area.insideLair(at(3615, 9797)), true, "corner");
  assert.equal(Area.insideLair(at(3614, 9812)), false, "west of the lair");
  assert.equal(Area.insideLair(at(3680, 9830)), false, "the webbed-tunnel approach");
  assert.equal(Area.insideLair(at(3633, 9821, 1)), false, "wrong plane");
  assert.equal(Area.insideLair(null), false);
});

test("edge distance measures to the 7x7 body, not its corner", () => {
  assert.equal(Shared.edgeDistance(3631, 9812, 3638, 9812), 1);
  assert.equal(Shared.edgeDistance(3631, 9812, 3637, 9818), 0, "under the body");
  assert.equal(Shared.edgeDistance(3631, 9812, 3631 - 4, 9812), 4);
  assert.equal(Shared.edgeDistance(3631, 9812, 3633, 9812 + 7), 1);
  assert.equal(Shared.underBoss(3631, 9812, 3633, 9815), true);
  assert.equal(Shared.underBoss(3631, 9812, 3638, 9815), false);
});

test("egg patterns are three full sets of three colours", () => {
  assert.equal(Shared.PATTERNS.length, 3);
  for (const pattern of Shared.PATTERNS) {
    assert.equal(pattern.length, Shared.EGG_TILES.length, "one egg per tile");
    for (const type of ["acidic", "mirrorback", "ruptura"]) {
      assert.equal(pattern.filter((entry) => entry === type).length, 3, `${type} x3`);
    }
    assert.ok(Shared.SPECIAL_FOR_PRIMARY[pattern[0]], "the first egg picks the special");
  }
  assert.equal(Shared.SPECIAL_FOR_PRIMARY.acidic, "ball");
  assert.equal(Shared.SPECIAL_FOR_PRIMARY.mirrorback, "splatter");
  assert.equal(Shared.SPECIAL_FOR_PRIMARY.ruptura, "drip");
});

test("the splatter scatters nine blobs around a tile within three", () => {
  for (let run = 0; run < 50; run++) {
    const tiles = Shared.splatterTiles(3633, 9816);
    assert.equal(tiles.length, 9);
    for (const [x, y] of tiles) {
      assert.ok(Math.abs(x - 3633) <= 3 && Math.abs(y - 9816) <= 3, "within the capture spread");
      assert.ok(x !== 3633 || y !== 9816, "never the caster's own tile untouched");
    }
  }
});

test("the spray fans outward along the boss-to-player direction", () => {
  for (let run = 0; run < 50; run++) {
    const tiles = Shared.splatterTiles(3633, 9816, null, { x: 10, y: 0 });
    assert.equal(tiles.length, 9);
    for (const [x, y] of tiles) {
      assert.ok(x - 3633 >= -1 && x - 3633 <= 3, "along the direction, mostly outward");
      assert.ok(Math.abs(y - 9816) <= 3, "lateral spread");
      assert.ok(x !== 3633 || y !== 9816, "never the caster's own tile untouched");
    }
  }
});

test("cleave pools run along the blow", () => {
  assert.deepEqual(Shared.cleavePoolTiles(10, 10, 0, -1), [[10, 10], [10, 9], [10, 11]]);
  assert.deepEqual(Shared.cleavePoolTiles(10, 10, 1, 0), [[10, 10], [9, 10], [11, 10]]);
  assert.deepEqual(Shared.cleavePoolTiles(10, 10, 0, 0), [[10, 10], [9, 10], [11, 10]]);
});

test("pool damage ramps to the Wiki's cap", () => {
  assert.equal(Shared.poolDamage(1), 4);
  assert.equal(Shared.poolDamage(2), 6);
  assert.equal(Shared.poolDamage(5), 12);
  assert.equal(Shared.poolDamage(9), 20);
  assert.equal(Shared.poolDamage(30), 20, "capped");
});

test("captured attack schedule: special on every seventh attack", () => {
  const specials = [];
  for (let attack = 1; attack <= 21; attack++) {
    if (attack % Shared.SPECIAL_EVERY_ATTACKS === 0) specials.push(attack);
  }
  assert.deepEqual(specials, [7, 14, 21], "first special at attack 7, then every 7");
});

test("wiki hatch schedule: first after 3 standards, then every 6", () => {
  let standards = 0;
  let next = Shared.FIRST_HATCH_STANDARDS;
  const hatches = [];
  for (let attack = 1; attack <= 30; attack++) {
    if (attack % Shared.SPECIAL_EVERY_ATTACKS === 0) continue; // specials are not standards
    standards += 1;
    if (standards >= next) {
      hatches.push(standards);
      next += Shared.HATCH_INTERVAL_STANDARDS;
    }
  }
  assert.deepEqual(hatches, [3, 9, 15, 21], "alternating with the specials at 6, 12, 18");
});

test("eggs sit SE-first, hatching clockwise around the centre", () => {
  assert.deepEqual(Shared.EGG_TILES[0], [3643, 9806], "first egg is the south-easternmost");
  const [cx, cy] = Shared.CENTRE_TILE;
  const bearings = Shared.EGG_TILES.map(([x, y]) => (Math.atan2(x - cx, y - cy) * 180 / Math.PI + 360) % 360);
  let prev = bearings[0];
  for (let i = 1; i < bearings.length; i++) {
    let cur = bearings[i];
    if (cur <= prev) cur += 360; // unwrap past north
    assert.ok(cur > prev, `tile ${i} continues clockwise`);
    prev = cur;
  }
});

test("idle minions are pointed back at the fighter, engaged ones untouched", () => {
  const area = {};
  const fighter = { isRegistered: () => true, getHitpoints: () => 99, getPrivateArea: () => area };
  const calls = [];
  const idle = {
    isRegistered: () => true, getHitpoints: () => 58,
    getCombat: () => ({ getTarget: () => null, attack: (t) => calls.push(["idle-attack", t]) }),
    setTarget: (t) => calls.push(["idle-target", t]),
  };
  const busy = {
    isRegistered: () => true, getHitpoints: () => 58,
    getCombat: () => ({ getTarget: () => fighter, attack: () => calls.push(["busy-attack"]) }),
    setTarget: () => calls.push(["busy-target"]),
  };
  const dead = { isRegistered: () => false, getHitpoints: () => 0 };
  Minions.ensureTargets({ fighter, area, minions: [idle, busy, dead] });
  assert.ok(calls.some(([k, t]) => k === "idle-target" && t === fighter), "idle minion retargeted");
  assert.ok(calls.some(([k, t]) => k === "idle-attack" && t === fighter), "idle minion ordered to attack");
  assert.ok(!calls.some(([k]) => k === "busy-target" || k === "busy-attack"), "engaged minion untouched");
});

test("minions stay idle when the fighter is gone or out of the instance", () => {
  const area = {};
  const elsewhere = {};
  const fighter = { isRegistered: () => true, getHitpoints: () => 99, getPrivateArea: () => elsewhere };
  let engaged = false;
  const minion = {
    isRegistered: () => true, getHitpoints: () => 58,
    getCombat: () => ({ getTarget: () => null, attack: () => { engaged = true; } }),
    setTarget: () => { engaged = true; },
  };
  Minions.ensureTargets({ fighter, area, minions: [minion] });
  assert.equal(engaged, false, "no cross-instance aggression");
  Minions.ensureTargets({ fighter: null, area, minions: [minion] });
  assert.equal(engaged, false, "no target, no engage");
});

test("step-under cleave self-hit rolls 8-12 on his own footprint", () => {
  assert.equal(Shared.CLEAVE_SELF_MIN, 8);
  assert.equal(Shared.CLEAVE_SELF_MAX, 12);
  assert.equal(Shared.underBoss(3631, 9812, 3633, 9815), true, "recorded tile under him");
  assert.equal(Shared.underBoss(3631, 9812, 3638, 9815), false, "recorded tile outside him");
});

test("mirrorback-bypass weapons are the halberd, crossbows and ballistas", () => {
  const player = (name) => ({
    getEquipment: () => ({
      getWeapon: () => ({
        getId: () => 1,
        getDefinition: () => ({ getName: () => name }),
      }),
    }),
  });
  assert.equal(Minions.instantKillWeapon(player("Noxious halberd")), true);
  assert.equal(Minions.instantKillWeapon(player("Rune crossbow")), true);
  assert.equal(Minions.instantKillWeapon(player("Dragon ballista")), true);
  assert.equal(Minions.instantKillWeapon(player("Abyssal whip")), false);
  assert.equal(Minions.instantKillWeapon(null), false);
  assert.equal(Minions.crushStyle(null), false, "null-safe without attach");
  assert.equal(Minions.crushStyle({}), false, "missing bonuses never qualify");
});

test("captured line-of-sight stepping is diagonal-first", () => {
  const open = () => true;
  assert.equal(Shared.hasClearPath(0, 0, 3, 3, open), true);
  assert.equal(Shared.hasClearPath(0, 0, 0, 0, open), true);
  const blocked = (x, y) => !(x === 1 && y === 1);
  assert.equal(Shared.hasClearPath(0, 0, 3, 3, blocked), false);
  assert.equal(Shared.hasClearPath(0, 0, 0, 3, blocked), true, "straight line misses the block");
});

test("spawned eggs are pinned: scripted movement and zero wander radius", () => {  const eggs = [];
  const fakeCore = {
    NPC: {
      create: () => {
        const egg = {
          scripted: undefined,
          radius: undefined,
          setHitpoints: () => {},
          performAnimation: () => {},
          setAttribute: () => {},
          setScriptedMovement: (value) => { egg.scripted = value; },
          getMovementCoordinator: () => ({ setRadius: (value) => { egg.radius = value; } }),
        };
        eggs.push(egg);
        return egg;
      },
    },
    Location: class {},
    Animation: class {},
    World: { getAddNPCQueue: () => [] },
    NpcIdentifiers: { EGG_10: 1, EGG_11: 2, EGG_12: 3, MIRRORBACK_ARAXYTE: 4, RUPTURA_ARAXYTE: 5, ACIDIC_ARAXYTE: 6 },
    CombatMethod: class {},
    CombatType: { MELEE: 0, RANGED: 1, MAGIC: 2 },
  };
  Minions.attach({
    core: fakeCore,
    onNpcHitModify: () => {},
    registerNpcCombatMethodProvider: () => {},
    getBonusManager: () => null,
  });
  const session = { npc: { getPrivateArea: () => null }, pattern: Shared.PATTERNS[0], eggs: [] };
  Minions.spawnEggs(session);
  assert.equal(eggs.length, 9, "one egg per pattern tile");
  for (const egg of eggs) {
    assert.equal(egg.radius, 0, "no wander radius");
    assert.equal(egg.scripted, true, "pinned: no retaliation chase when attacked");
  }
});

test("pinEggs clears the fighting egg's interaction and combat target", () => {
  const calls = [];
  const egg = {
    isRegistered: () => true,
    getInteractingMobile: () => ({ fake: "player" }),
    setMobileInteraction: (value) => calls.push(["mob", value]),
    getCombat: () => ({ reset: () => calls.push(["reset"]) }),
  };
  Minions.pinEggs({ eggs: [{ npc: egg }] });
  assert.ok(calls.some(([kind, value]) => kind === "mob" && value === null), "interaction cleared");
  assert.ok(calls.some(([kind]) => kind === "reset"), "combat target cleared");
});
