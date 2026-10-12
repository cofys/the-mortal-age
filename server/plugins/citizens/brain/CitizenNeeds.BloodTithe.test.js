"use strict";

/**
 * CitizenNeeds / BloodTithe reader fixes — regression tests.
 *
 * The BloodTithe engine keys its debt ledger flags by LOWERCASED username
 * (`morytania:blood-tithe:debt:<lower>`). These tests pin the citizen-side
 * readers to the same keying so mixed-case usernames resolve their debt,
 * and pin the engine's round-active flag contract (set true around each
 * round, cleared after) that tithe_collection_duty scoring reads.
 */

const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const Module = require("node:module");

// Same stub the engine suite uses: the TS core Task class isn't compiled
// in unit-test land.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../src/main/typescript/elvarg/game/task/Task") {
    return { Task: class Task {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Store = require("../../kingdoms/KingdomStore");
const {
  ensureNeeds,
  dropNeeds,
  tickBloodDebt,
  titheDebtFromLedger,
} = require("./CitizenNeeds");
const { titheInfo } = require("./CitizenDecisions");
const BloodTithe = require("../../kingdoms/BloodTithe.Kingdoms");

const M = "morytania";

function seed() {
  Store.resetForTests();
  Store.upsertKingdom({ id: M, name: "Morytania", capital: "Darkmeyer" });
  Store.getKingdom(M).flags = {};
}

function mockCitizen({ username, kingdom = M } = {}) {
  const attrs = { "kingdom:id": kingdom };
  return {
    getUsername: () => username,
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
  };
}

describe("blood tithe reader fixes", () => {
  beforeEach(() => {
    seed();
  });

  it("titheDebtFromLedger resolves mixed-case usernames to the lowercase-keyed flag", () => {
    Store.setFlag(M, "morytania:blood-tithe:debt:debt-user", 1200);
    assert.equal(titheDebtFromLedger("Debt-User"), 1200);
    assert.equal(titheDebtFromLedger("DEBT-USER"), 1200);
    assert.equal(titheDebtFromLedger("debt-user"), 1200);
  });

  it("tickBloodDebt surfaces ledger debt for a mixed-case Morytanian citizen", () => {
    const username = `debt-user-${Date.now() % 100000}`;
    Store.setFlag(M, `morytania:blood-tithe:debt:${username.toLowerCase()}`, 750);
    const player = mockCitizen({ username });
    const needs = ensureNeeds(username);
    needs.bloodDebt = 0;
    const out = tickBloodDebt(username, player);
    assert.equal(out.bloodDebt, 750);
    dropNeeds(username);
  });

  it("titheInfo finds mixed-case debt for a Morytanian guard citizen", () => {
    const username = `guard-user-${Date.now() % 100000}`;
    Store.setFlag(M, `morytania:blood-tithe:debt:${username.toLowerCase()}`, 900);
    const player = mockCitizen({ username });
    player.setAttribute("citizen:role", "guard");
    const info = titheInfo(player);
    assert.equal(info.morytanian, true);
    assert.equal(info.bloodDebt, 900);
    dropNeeds(username);
  });

  it("engine clears the round-active flag after a round (and it was written)", () => {
    const username = `round-user-${Date.now() % 100000}`;
    const purse = { 995: 0 };
    const player = {
      getUsername: () => username,
      isPlayerBot: () => false,
      getAttribute: (k) => (k === "kingdom:id" ? M : null),
      setAttribute: () => {},
      getInventory: () => ({
        getAmount: (id) => purse[id] ?? 0,
        delete: (id, n) => {
          purse[id] = Math.max(0, (purse[id] ?? 0) - n);
        },
        refreshItems: () => {},
      }),
      getLocation: () => ({ getX: () => 3490, getY: () => 3480 }),
      sendMessage: () => {},
    };
    const api = {
      core: {
        World: { getPlayers: () => ({ stream: () => ({ toArray: () => [player] }) }) },
      },
    };
    const res = BloodTithe.runTitheRoundForce(api, Store, {});
    assert.equal(res.ok, true);
    // Flag was written by the engine and cleared at round end (not absent).
    assert.equal(Store.getKingdom(M).flags["morytania:blood-tithe:round-active"], false);
    // The round itself still did its work: broke citizen recorded debt.
    assert.equal(
      Store.getKingdom(M).flags[`morytania:blood-tithe:debt:${username.toLowerCase()}`].debt > 0,
      true
    );
  });
});
