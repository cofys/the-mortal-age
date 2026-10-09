"use strict";

/**
 * CitizenGuildLife.test.js — tick tests for the guild system.
 * The tick never throws; journaling and speech are best-effort.
 */

const GuildLife = require("./CitizenGuildLife");
const Guilds = require("./CitizenGuilds");

const fs = require("fs");
const os = require("os");
const path = require("path");

const SAVE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "guildlife-test-")), "citizen-guilds.json");

function makeDirector(records) {
  const roster = new Map(records.map((r) => [r.username, r]));
  return {
    roster,
    isOnline: () => true,
    getBot: (record) => ({ username: record.username }),
    getPlayer: () => null,
    getLocalPlayers: () => [],
    log: () => {},
  };
}

function memberRecord(username) {
  return { username, role: "commoner" };
}

function forceMember(name, guildId) {
  const p = {
    getInventory: () => ({ count: () => 5000, remove: () => {} }),
    getSkills: () => ({ getLevel: () => 99 }),
  };
  const res = Guilds.joinGuild(name, guildId, p);
  expect(res.ok).toBe(true);
}

beforeEach(() => {
  Guilds._setSavePathForTests(SAVE);
  Guilds.resetForTests();
  try { fs.unlinkSync(SAVE); } catch { /* fresh */ }
});

describe("tickGuilds", () => {
  test("never throws on empty director", () => {
    expect(() => GuildLife.tickGuilds(null)).not.toThrow();
    expect(() => GuildLife.tickGuilds({})).not.toThrow();
    expect(() => GuildLife.tickGuilds(makeDirector([]))).not.toThrow();
  });

  test("never throws when guild module is missing", () => {
    // The tick requires ./CitizenGuilds which exists; simulate a broken
    // director instead.
    const d = makeDirector([memberRecord("Zed")]);
    d.roster = { values: () => { throw new Error("boom"); } };
    expect(() => GuildLife.tickGuilds(d)).not.toThrow();
  });

  test("rank-up is announced and journaled once", () => {
    forceMember("Ann", "warriors");
    const d = makeDirector([memberRecord("Ann")]);
    Guilds.addFavor("Ann", 100, "test"); // member
    GuildLife.tickGuilds(d);
    const rec = d.roster.get("Ann");
    expect(rec.guildRankAnnounced["guild_rank:warriors:member"]).toBe(true);
    // Second tick does not re-announce.
    GuildLife.tickGuilds(d);
    expect(Object.keys(rec.guildRankAnnounced)).toHaveLength(1);
  });

  test("expired missions are abandoned", () => {
    forceMember("Bob", "mages");
    Guilds.startMission("Bob");
    const d = makeDirector([memberRecord("Bob")]);
    const future = Date.now() + 8 * 24 * 3600 * 1000;
    GuildLife.tickGuilds(d, future);
    expect(Guilds.missionFor("Bob")).toBeNull();
  });

  test("rivalry cools over time", () => {
    Guilds.nudgeRivalry("warriors", "mages", 10);
    const d = makeDirector([]);
    GuildLife.tickGuilds(d);
    expect(Guilds.rivalryFor("warriors", "mages")).toBe(9);
  });

  test("training at the hall earns favor", () => {
    forceMember("Cat", "crafters");
    const rec = memberRecord("Cat");
    const now = Date.now();
    rec.guildTrainedAt = now;
    rec.guildTrainedGuild = "crafters";
    const d = makeDirector([rec]);
    GuildLife.tickGuilds(d, now);
    expect(Guilds.favorFor("Cat")).toBe(5);
    // Same training timestamp does not double-award.
    GuildLife.tickGuilds(d, now + 1000);
    expect(Guilds.favorFor("Cat")).toBe(5);
  });

  test("training for the wrong guild earns nothing", () => {
    forceMember("Dan", "thieves");
    const rec = memberRecord("Dan");
    rec.guildTrainedAt = Date.now();
    rec.guildTrainedGuild = "warriors"; // not his guild
    const d = makeDirector([rec]);
    GuildLife.tickGuilds(d);
    expect(Guilds.favorFor("Dan")).toBe(0);
  });

  test("non-members are skipped silently", () => {
    const d = makeDirector([memberRecord("Eve")]);
    expect(() => GuildLife.tickGuilds(d)).not.toThrow();
    expect(Guilds.membershipFor("Eve")).toBeNull();
  });
});
