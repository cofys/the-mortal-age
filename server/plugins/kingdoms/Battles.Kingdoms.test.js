"use strict";

/**
 * Battles unit checks — field battles as joinable events: calling gates,
 * the muster → fighting lifecycle, kill recording, resolution into the
 * war score. Uses a fake spawn api; no running server.
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const Battles = require("./Battles.Kingdoms");
const WarResolution = require("./WarResolution.Kingdoms");

function mockStore() {
  const state = {
    kingdoms: {
      asgarnia: { id: "asgarnia", name: "Asgarnia", treasury: 0 },
      misthalin: { id: "misthalin", name: "Misthalin", treasury: 0 },
    },
    castles: {
      asgarnia: { warChest: 500000, fortTier: 1, buildings: {} },
      misthalin: { warChest: 500000, fortTier: 1, buildings: {} },
    },
    wars: [
      {
        attackerId: "asgarnia",
        defenderId: "misthalin",
        goal: "loot",
        declaredBy: "tester",
        active: true,
        declaredAt: Date.now(),
        endedAt: null,
        outcome: null,
        score: { attacker: 0, defender: 0 },
      },
    ],
    tension: {},
    battles: [],
  };
  return {
    load: () => state,
    save: () => {},
    _state: () => state,
  };
}

function fakeApi() {
  const spawned = [];
  return {
    spawned,
    core: { World: { getPlayers: () => ({ stream: () => ({ filter: () => ({ forEach: () => {} }) }) }) } },
    spawnNpc(spec) {
      const npc = {
        ...spec,
        dead: false,
        isDead() { return this.dead; },
        isDying() { return false; },
        isRegistered() { return !this.dead; },
        unregister() { this.dead = true; },
      };
      spawned.push(npc);
      return npc;
    },
  };
}

describe("callBattle gates", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("requires an active war", () => {
    store.load().wars = [];
    assert.equal(Battles.callBattle("asgarnia", "misthalin", store).reason, "not-at-war");
  });

  it("refuses a second live battle on the same border", () => {
    const r1 = Battles.callBattle("asgarnia", "misthalin", store, { now: 1000 });
    assert.equal(r1.ok, true);
    assert.equal(r1.battle.status, "mustering");
    const r2 = Battles.callBattle("misthalin", "asgarnia", store, { now: 2000 });
    assert.equal(r2.reason, "battle-already-called");
  });

  it("records the border field and the muster window", () => {
    const r = Battles.callBattle("asgarnia", "misthalin", store, { now: 5000 });
    assert.equal(r.ok, true);
    assert.ok(Number.isFinite(r.battle.site.x) && Number.isFinite(r.battle.site.y));
    assert.equal(r.battle.musterEndsAt, 5000 + Battles.BATTLE_CONFIG.MUSTER_MS);
  });
});

describe("battle lifecycle", () => {
  let store;
  let api;
  beforeEach(() => {
    store = mockStore();
    api = fakeApi();
    Battles._hosts.clear();
  });

  it("muster ends → hosts spawn tagged for their crowns", () => {
    const { battle } = Battles.callBattle("asgarnia", "misthalin", store, { now: 0 });
    Battles.tickBattles(null, api, store, Battles.BATTLE_CONFIG.MUSTER_MS + 1);
    assert.equal(battle.status, "fighting");
    assert.ok(api.spawned.length >= Battles.BATTLE_CONFIG.BASE_NPCS * 2);
    const atkHost = api.spawned.find((n) => n.warBattle?.forKingdomId === "asgarnia");
    const defHost = api.spawned.find((n) => n.warBattle?.forKingdomId === "misthalin");
    assert.ok(atkHost && defHost);
    assert.equal(atkHost.warBattle.battleId, battle.id);
  });

  it("kills are recorded per kingdom and only during fighting", () => {
    const { battle } = Battles.callBattle("asgarnia", "misthalin", store, { now: 0 });
    assert.equal(Battles.recordBattleKill(battle.id, "asgarnia", store), false); // still mustering
    Battles.tickBattles(null, api, store, Battles.BATTLE_CONFIG.MUSTER_MS + 1);
    assert.equal(Battles.recordBattleKill(battle.id, "asgarnia", store), true);
    assert.equal(Battles.recordBattleKill(battle.id, "asgarnia", store), true);
    assert.equal(battle.kills.asgarnia, 2);
    assert.equal(Battles.recordBattleKill(battle.id, "kandarin", store), false); // not a belligerent
  });

  it("a wiped host loses the battle and feeds the war score", () => {
    const { battle } = Battles.callBattle("asgarnia", "misthalin", store, { now: 0 });
    Battles.tickBattles(null, api, store, Battles.BATTLE_CONFIG.MUSTER_MS + 1);
    // Kill every misthalin soldier.
    for (const npc of api.spawned) {
      if (npc.warBattle?.forKingdomId === "misthalin") npc.dead = true;
    }
    Battles.tickBattles(null, api, store, Battles.BATTLE_CONFIG.MUSTER_MS + 2);
    assert.equal(battle.status, "resolved");
    assert.equal(battle.winnerId, "asgarnia");
    const snap = WarResolution.warScoreBetween("asgarnia", "misthalin", store);
    assert.equal(snap.score.attacker, WarResolution.WAR_RESOLUTION_CONFIG.SCORE_BATTLE_VICTORY);
  });

  it("at the horn, more kills wins; a tie is drawn", () => {
    const { battle } = Battles.callBattle("asgarnia", "misthalin", store, { now: 0 });
    const fightAt = Battles.BATTLE_CONFIG.MUSTER_MS + 1;
    Battles.tickBattles(null, api, store, fightAt);
    Battles.recordBattleKill(battle.id, "misthalin", store);
    Battles.recordBattleKill(battle.id, "misthalin", store);
    Battles.recordBattleKill(battle.id, "asgarnia", store);
    Battles.tickBattles(null, api, store, fightAt + Battles.BATTLE_CONFIG.DURATION_MS + 1);
    assert.equal(battle.status, "resolved");
    assert.equal(battle.winnerId, "misthalin");
    assert.equal(battle.outcome, "kills-at-the-horn");
  });

  it("a battle whose war ended resolves quietly", () => {
    const { battle } = Battles.callBattle("asgarnia", "misthalin", store, { now: 0 });
    store.load().wars[0].active = false;
    Battles.tickBattles(null, api, store, 100);
    assert.equal(battle.status, "resolved");
    assert.equal(battle.outcome, "war-ended");
  });

  it("the border rests after a battle (cooldown)", () => {
    const { battle } = Battles.callBattle("asgarnia", "misthalin", store, { now: 0 });
    battle.status = "resolved";
    battle.resolvedAt = 1000;
    const r = Battles.callBattle("asgarnia", "misthalin", store, { now: 2000 });
    assert.equal(r.reason, "battle-on-cooldown");
  });
});

describe("battle site for the militia brain", () => {
  it("exposes the field while a battle is live", () => {
    const store = mockStore();
    Battles.callBattle("asgarnia", "misthalin", store, { now: 0 });
    const site = Battles.activeBattleSiteFor("misthalin", store);
    assert.ok(site && Number.isFinite(site.x));
    assert.equal(Battles.activeBattleSiteFor("kandarin", store), null);
  });
});
