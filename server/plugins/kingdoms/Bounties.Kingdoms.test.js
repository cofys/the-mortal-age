"use strict";

/**
 * Bounties.Kingdoms — the wanted board.
 *
 * Covers: posting escrows real treasury coin, escalation, the funding
 * cap when a treasury is short, gradual decay with refunds, the clean
 * cap clearing a record, and collection paying only the contract holder.
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../src/main/typescript/elvarg/game/task/Task") {
    return { Task: class Task {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Store = require("./KingdomStore");
const Bounties = require("./Bounties.Kingdoms");
const Jobs = require("./Jobs.Kingdoms");

const A = "asgarnia";
const M = "misthalin";
const DAY = 24 * 3600 * 1000;

function seed(treasuryA = 100000) {
  Store.resetForTests();
  Store.upsertKingdom({ id: A, name: "Asgarnia", capital: "Falador" });
  Store.upsertKingdom({ id: M, name: "Misthalin", capital: "Varrock" });
  Store.getKingdom(A).treasury = treasuryA;
  Store.getKingdom(A).flags = {};
  Store.getKingdom(M).treasury = 100000;
  Store.getKingdom(M).flags = {};
}

function mockHunter(name) {
  const attrs = { "kingdom:id": M };
  const inv = {};
  return {
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    getUsername: () => name,
    isPlayerBot: () => false,
    getLocation: () => ({ getX: () => 3165, getY: () => 3485, getZ: () => 0 }),
    getInventory: () => ({
      getAmount: (id) => inv[id] ?? 0,
      delete: (id, n) => {
        inv[id] = Math.max(0, (inv[id] ?? 0) - n);
      },
      deleteNumber: (id, n) => {
        inv[id] = Math.max(0, (inv[id] ?? 0) - n);
      },
      adds: (id, n) => {
        inv[id] = (inv[id] ?? 0) + n;
      },
      refreshItems: () => {},
    }),
    sendMessage: () => {},
  };
}

describe("Bounties posting and escalation", () => {
  beforeEach(() => seed());

  it("posting escrows the per-crime amount from the issuing treasury", () => {
    const rec = Bounties.markWanted("Thief", A, "theft", Store);
    assert.equal(rec.amount, Bounties.BOUNTY_CONFIG.PER_CRIME.theft);
    assert.equal(Store.getKingdom(A).treasury, 100000 - rec.amount);
  });

  it("a second crime escalates the same record and escrows the increment", () => {
    Bounties.markWanted("Thief", A, "theft", Store);
    const rec = Bounties.markWanted("Thief", A, "assault", Store);
    assert.equal(rec.crimes, 2);
    assert.equal(
      rec.amount,
      Bounties.BOUNTY_CONFIG.PER_CRIME.theft + Bounties.BOUNTY_CONFIG.PER_CRIME.assault
    );
    assert.equal(Store.getKingdom(A).treasury, 100000 - rec.amount);
  });

  it("a short treasury caps the bounty at what it actually funded", () => {
    seed(100);
    const rec = Bounties.markWanted("Saboteur", A, "sabotage", Store);
    assert.ok(rec, "a partially funded bounty still posts");
    assert.ok(rec.amount > 0 && rec.amount <= 100, `funded ${rec.amount}`);
    assert.equal(Store.getKingdom(A).treasury, 100 - rec.amount);
  });

  it("an empty treasury posts nothing", () => {
    seed(0);
    assert.equal(Bounties.markWanted("Saboteur", A, "sabotage", Store), null);
    assert.equal(Bounties.listWanted(Store).length, 0);
  });
});

describe("Bounties amountOverride (bank robbery)", () => {
  beforeEach(() => seed(2000000));

  it("posts the override amount instead of the per-crime default", () => {
    // 100k + 25% of a 400k take.
    const rec = Bounties.markWanted("Robber", A, "bank-robbery", Store, 200000);
    assert.ok(rec);
    assert.equal(rec.amount, 200000);
    assert.equal(rec.crime, "bank-robbery");
    assert.equal(Store.getKingdom(A).treasury, 2000000 - 200000);
  });

  it("caps the override at MAX_AMOUNT", () => {
    const rec = Bounties.markWanted("Robber", A, "bank-robbery", Store, 5000000);
    assert.ok(rec);
    assert.equal(rec.amount, Bounties.BOUNTY_CONFIG.MAX_AMOUNT);
  });

  it("escalates an existing record by the override", () => {
    Bounties.markWanted("Robber", A, "theft", Store);
    const rec = Bounties.markWanted("Robber", A, "bank-robbery", Store, 200000);
    assert.equal(rec.crimes, 2);
    assert.equal(rec.amount, Bounties.BOUNTY_CONFIG.PER_CRIME.theft + 200000);
  });

  it("a four-arg call still uses the per-crime default (backwards compatible)", () => {
    const rec = Bounties.markWanted("Thief", A, "theft", Store);
    assert.equal(rec.amount, Bounties.BOUNTY_CONFIG.PER_CRIME.theft);
  });
});

describe("Bounties decay (gradual, refunding)", () => {
  beforeEach(() => seed());

  it("clean days shrink the bounty and refund the shrink to the treasury", () => {
    const rec = Bounties.markWanted("Thief", A, "assault", Store);
    const startAmount = rec.amount;
    const treasuryAfterPost = Store.getKingdom(A).treasury;
    // Two clean days pass.
    rec.lastCrimeAt = Date.now() - 2 * DAY;
    rec.lastDecayAt = rec.lastCrimeAt;
    const live = Bounties.listWanted(Store, A);
    assert.equal(live.length, 1);
    assert.ok(live[0].amount < startAmount, "bounty shrank");
    assert.equal(
      Store.getKingdom(A).treasury,
      treasuryAfterPost + (startAmount - live[0].amount),
      "the shrunk portion refunded"
    );
  });

  it("staying clean past the cap clears the record and refunds the rest", () => {
    const rec = Bounties.markWanted("Thief", A, "assault", Store);
    const startAmount = rec.amount;
    rec.lastCrimeAt = Date.now() - (Bounties.BOUNTY_CONFIG.CLEAN_MS + DAY);
    rec.lastDecayAt = rec.lastCrimeAt;
    assert.equal(Bounties.listWanted(Store, A).length, 0);
    assert.equal(Store.getKingdom(A).treasury, 100000, "full escrow returned over time");
    assert.ok(startAmount > 0);
  });

  it("a fresh crime resets the clean clock", () => {
    const rec = Bounties.markWanted("Thief", A, "theft", Store);
    rec.lastCrimeAt = Date.now() - 2 * DAY;
    rec.lastDecayAt = rec.lastCrimeAt;
    const again = Bounties.markWanted("Thief", A, "theft", Store);
    assert.equal(again.crimes, 2);
    assert.ok(Date.now() - again.lastCrimeAt < 5000);
  });
});

describe("Bounties collection", () => {
  beforeEach(() => seed());

  it("only the contract holder collects, paid from the record's escrow", () => {
    const rec = Bounties.markWanted("Outlaw", A, "sabotage", Store);
    // A stranger cannot collect.
    assert.equal(Bounties.collect("Outlaw", "Stranger", Store), null);
    // The hunter takes the contract off the board, then collects.
    const hunter = mockHunter("Hunter");
    const board = Jobs.boardFor(M, Store);
    const bountyJob = board.find((j) => j.type === "bounty");
    assert.ok(bountyJob, "wanted appears on the job board");
    assert.equal(bountyJob.rewardGold, rec.amount);
    assert.ok(Jobs.claim(hunter, bountyJob.id, Store).ok);
    const treasuryBefore = Store.getKingdom(A).treasury;
    const got = Bounties.collect("Outlaw", "Hunter", Store);
    assert.ok(got);
    assert.equal(got.payout, rec.amount);
    assert.equal(Bounties.listWanted(Store).length, 0);
    assert.equal(Store.getKingdom(A).treasury, treasuryBefore, "no second treasury dip");
    // A second hunter cannot claim a ghost.
    assert.equal(Bounties.collect("Outlaw", "Hunter", Store), null);
  });

  it("one active bounty contract per hunter", () => {
    Bounties.markWanted("Outlaw", A, "sabotage", Store);
    Bounties.markWanted("Bandit", A, "assault", Store);
    const hunter = mockHunter("Hunter");
    const board = Jobs.boardFor(M, Store);
    const bounties = board.filter((j) => j.type === "bounty");
    assert.equal(bounties.length, 2);
    assert.ok(Jobs.claim(hunter, bounties[0].id, Store).ok);
    assert.equal(Jobs.claim(hunter, bounties[1].id, Store).reason, "already-hunting");
  });
});
