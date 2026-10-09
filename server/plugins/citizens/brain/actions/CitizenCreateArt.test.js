"use strict";

/**
 * CitizenCreateArt.test.js — brain action tests. Plain node, mocked player.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const Art = require("../../lib/CitizenArt");
const { createCitizenCreateArtAction, ACTION_ID } = require("./CitizenCreateArt");

const TMP_SAVE = path.join(os.tmpdir(), `citizen-createart-test-${process.pid}.json`);

function makePlayer(username, itemMap = {}) {
  const items = new Map(Object.entries(itemMap).map(([k, v]) => [Number(k), v]));
  return {
    username,
    getUsername: () => username,
    personality: { creativity: 0.8 },
    getSkills: () => ({
      getLevel: (skill) => (skill === "crafting" ? 50 : 1),
      addXp: () => {},
    }),
    getInventory: () => ({
      getAmount: (id) => items.get(id) ?? 0,
      remove: (id, n) => {
        const cur = items.get(id) ?? 0;
        items.set(id, Math.max(0, cur - n));
      },
      _items: items,
    }),
  };
}

beforeEach(() => {
  Art._setSavePathForTests(TMP_SAVE);
  Art.resetForTests();
  try { fs.unlinkSync(TMP_SAVE); } catch { /* ignore */ }
});

afterEach(() => {
  try { fs.unlinkSync(TMP_SAVE); } catch { /* ignore */ }
});

describe("CitizenCreateArt", () => {
  test("ACTION_ID is citizenCreateArt", () => {
    expect(ACTION_ID).toBe("citizenCreateArt");
  });

  test("no materials → done, no-materials", async () => {
    const action = createCitizenCreateArtAction();
    const player = makePlayer("Alice", {});
    const result = await action.run(player, { kingdomId: "varrock" });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("no-materials");
  });

  test("creates painting with papyrus + dye", async () => {
    const action = createCitizenCreateArtAction();
    // 970 = papyrus, 1763 = red dye.
    const player = makePlayer("Alice", { 970: 5, 1763: 3 });
    const result = await action.run(player, { kingdomId: "varrock" });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("created");
    expect(result.medium).toBe("painting");
    expect(result.artworkId).toBeTruthy();
    // Materials consumed.
    const inv = player.getInventory();
    expect(inv.getAmount(970)).toBe(4); // 5 - 1
    expect(inv.getAmount(1763)).toBe(2); // 3 - 1
    // Artwork recorded.
    expect(Art.artworksOf("Alice")).toHaveLength(1);
  });

  test("creates sculpture with clay + chisel (chisel not consumed)", async () => {
    const action = createCitizenCreateArtAction();
    // 1761 = soft clay, 1755 = chisel.
    const player = makePlayer("Bob", { 1761: 4, 1755: 1 });
    const result = await action.run(player, { kingdomId: "varrock" });
    expect(result.ok).toBe(true);
    expect(result.medium).toBe("sculpture"); // preferred over painting
    const inv = player.getInventory();
    expect(inv.getAmount(1761)).toBe(2); // 4 - 2
    expect(inv.getAmount(1755)).toBe(1); // chisel kept
  });

  test("sculpture requires chisel — falls back to painting", async () => {
    const action = createCitizenCreateArtAction();
    // Clay but no chisel, plus painting materials.
    const player = makePlayer("Carol", { 1761: 4, 970: 2, 1765: 1 });
    const result = await action.run(player, { kingdomId: "varrock" });
    expect(result.medium).toBe("painting"); // sculpture blocked, painting ok
  });

  test("give-up after timeout", async () => {
    const action = createCitizenCreateArtAction();
    const player = makePlayer("Alice", { 970: 5, 1763: 3 });
    const old = Date.now() - 11 * 60 * 1000;
    const result = await action.run(player, { startedAt: old, kingdomId: "varrock" });
    expect(result.reason).toBe("give-up");
  });

  test("masterpiece earns reputation and announcement", async () => {
    const said = [];
    const action = createCitizenCreateArtAction({ sayPublic: (m) => said.push(m) });
    // Level 99 + full creativity = quality 100 = masterpiece.
    const player = makePlayer("Master", { 970: 5, 1763: 3 });
    player.getSkills = () => ({
      getLevel: () => 99,
      addXp: () => {},
    });
    player.personality = { creativity: 1.0 };
    const result = await action.run(player, { kingdomId: "varrock", creativity: 1.0 });
    expect(result.reason).toBe("created");
    const art = Art.artworksOf("Master")[0];
    expect(Art.isMasterpiece(art)).toBe(true);
    expect(said.length).toBeGreaterThan(0);
    expect(said[0]).toMatch(/masterpiece/i);
  });
});
