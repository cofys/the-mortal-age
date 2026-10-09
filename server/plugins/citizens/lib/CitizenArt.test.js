"use strict";

/**
 * CitizenArt.test.js — data tier tests. Plain node, no engine needed.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const Art = require("./CitizenArt");

const TMP_SAVE = path.join(os.tmpdir(), `citizen-art-test-${process.pid}.json`);

beforeEach(() => {
  Art._setSavePathForTests(TMP_SAVE);
  Art.resetForTests();
  try { fs.unlinkSync(TMP_SAVE); } catch { /* ignore */ }
});

afterEach(() => {
  try { fs.unlinkSync(TMP_SAVE); } catch { /* ignore */ }
});

describe("CitizenArt", () => {
  test("ART_MEDIUMS uses real item ids", () => {
    expect(Art.ART_MEDIUMS.painting.materials[0].item).toBe(970); // papyrus
    expect(Art.ART_MEDIUMS.sculpture.materials[0].item).toBe(1761); // soft clay
    expect(Art.ART_MEDIUMS.sculpture.tools).toContain(1755); // chisel
    expect(Art.ART_MEDIUMS.writing.materials[0].item).toBe(970); // papyrus
  });

  test("painting accepts any dye color", () => {
    const dyeMat = Art.ART_MEDIUMS.painting.materials.find((m) => m.anyOf);
    expect(dyeMat.anyOf).toContain(1763); // red
    expect(dyeMat.anyOf).toContain(1765); // yellow
    expect(dyeMat.anyOf).toContain(1767); // blue
  });

  test("createArtwork derives quality from skill + creativity, not random", () => {
    const master = Art.createArtwork("Alice", "painting", 99, 1.0, "varrock", 1000);
    const novice = Art.createArtwork("Bob", "painting", 1, 0.0, "varrock", 2000);
    expect(master.quality).toBe(100); // 60 + 40
    expect(novice.quality).toBe(1); // ~0.6 + 0, floored at 1
    expect(master.quality).toBeGreaterThan(novice.quality);
  });

  test("createArtwork quality is deterministic for same inputs", () => {
    const a = Art.createArtwork("Alice", "sculpture", 50, 0.5, "varrock", 1000);
    Art.resetForTests();
    Art._setSavePathForTests(TMP_SAVE);
    const b = Art.createArtwork("Alice", "sculpture", 50, 0.5, "varrock", 1000);
    expect(a.quality).toBe(b.quality);
    expect(a.title).toBe(b.title);
  });

  test("createArtwork rejects unknown medium", () => {
    expect(Art.createArtwork("Alice", "dance", 50, 0.5, "varrock")).toBeNull();
  });

  test("createArtwork generates titles from word pools", () => {
    const art = Art.createArtwork("Alice", "painting", 50, 0.5, "varrock", 1000);
    expect(art.title).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    const words = art.title.split(" ");
    expect(Art.TITLE_ADJECTIVES).toContain(words[0]);
    expect(Art.TITLE_SUBJECTS).toContain(words[1]);
  });

  test("artworksOf finds by artist and owner", () => {
    Art.createArtwork("Alice", "painting", 50, 0.5, "varrock", 1000);
    Art.createArtwork("Bob", "sculpture", 50, 0.5, "varrock", 2000);
    expect(Art.artworksOf("Alice")).toHaveLength(1);
    expect(Art.artworksOf("alice")).toHaveLength(1); // normalized
    expect(Art.artworksOf("Bob")).toHaveLength(1);
    expect(Art.artworksOf("Nobody")).toHaveLength(0);
  });

  test("valueFor scales with quality", () => {
    const low = Art.createArtwork("Alice", "painting", 1, 0, "varrock", 1000);
    const high = Art.createArtwork("Bob", "painting", 99, 1, "varrock", 2000);
    expect(Art.valueFor(high)).toBeGreaterThan(Art.valueFor(low));
    expect(Art.valueFor(low)).toBeGreaterThan(0);
  });

  test("valueFor degrades safely without reputation module", () => {
    // valueFor catches require failures internally; just verify it returns a number.
    const art = Art.createArtwork("Alice", "painting", 50, 0.5, "varrock", 1000);
    expect(typeof Art.valueFor(art)).toBe("number");
  });

  test("listForSale and marketListings round-trip", () => {
    const art = Art.createArtwork("Alice", "painting", 50, 0.5, "varrock", 1000);
    expect(Art.marketListings("varrock")).toHaveLength(0);
    Art.listForSale(art.id, 100, 2000);
    const listings = Art.marketListings("varrock");
    expect(listings).toHaveLength(1);
    expect(listings[0].price).toBe(100);
    // Other kingdoms don't see it.
    expect(Art.marketListings("falador")).toHaveLength(0);
  });

  test("listForSale defaults to honest value when price is 0", () => {
    const art = Art.createArtwork("Alice", "painting", 50, 0.5, "varrock", 1000);
    Art.listForSale(art.id, 0, 2000);
    expect(Art.marketListings("varrock")[0].price).toBe(Art.valueFor(art));
  });

  test("buyArtwork transfers ownership and takes real coins", () => {
    const art = Art.createArtwork("Alice", "painting", 50, 0.5, "varrock", 1000);
    Art.listForSale(art.id, 100, 2000);

    let buyerCoins = 500;
    let sellerPaid = 0;
    const buyer = {
      username: "Bob",
      getUsername: () => "Bob",
      getInventory: () => ({
        getAmount: (id) => (id === 995 ? buyerCoins : 0),
        deleteNumber: (id, amt) => { if (id === 995) buyerCoins -= amt; },
        adds: (id, amt) => { if (id === 995) buyerCoins += amt; },
      }),
    };
    const result = Art.buyArtwork(art.id, buyer, (seller, amt) => {
      sellerPaid = amt;
      return true;
    });
    expect(result.ok).toBe(true);
    expect(buyerCoins).toBe(400); // 500 - 100
    expect(sellerPaid).toBe(100);
    expect(Art.artworksOf("Bob")).toHaveLength(1); // Bob owns it now
    expect(Art.marketListings("varrock")).toHaveLength(0); // no longer listed
  });

  test("buyArtwork fails honestly when buyer is broke", () => {
    const art = Art.createArtwork("Alice", "painting", 50, 0.5, "varrock", 1000);
    Art.listForSale(art.id, 100, 2000);
    const buyer = {
      username: "Bob",
      getInventory: () => ({
        getAmount: () => 50, // only 50 coins
        deleteNumber: () => {},
        adds: () => {},
      }),
    };
    const result = Art.buyArtwork(art.id, buyer, () => true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("insufficient-coins");
    expect(Art.marketListings("varrock")).toHaveLength(1); // still listed
  });

  test("buyArtwork fails for unknown or unlisted art", () => {
    const buyer = { getInventory: () => ({ getAmount: () => 1000, deleteNumber: () => {}, adds: () => {} }) };
    expect(Art.buyArtwork("nope", buyer, () => true).reason).toBe("not-found");
    const art = Art.createArtwork("Alice", "painting", 50, 0.5, "varrock", 1000);
    expect(Art.buyArtwork(art.id, buyer, () => true).reason).toBe("not-for-sale");
  });

  test("expireListings removes stale listings", () => {
    const art = Art.createArtwork("Alice", "painting", 50, 0.5, "varrock", 1000);
    const old = 1000 - 15 * 24 * 60 * 60 * 1000; // 15 days ago
    Art.listForSale(art.id, 100, old);
    expect(Art.marketListings("varrock")).toHaveLength(1);
    const expired = Art.expireListings(1000);
    expect(expired).toBe(1);
    expect(Art.marketListings("varrock")).toHaveLength(0);
  });

  test("galleryFor creates one gallery per kingdom", () => {
    const g1 = Art.galleryFor("varrock", 1000);
    const g2 = Art.galleryFor("varrock", 2000);
    const g3 = Art.galleryFor("falador", 1000);
    expect(g1).toBe(g2); // same object
    expect(g1.kingdomId).toBe("varrock");
    expect(g3.kingdomId).toBe("falador");
  });

  test("hostExhibition displays top works and respects cooldown", () => {
    // hostExhibition exhibits whatever unexhibited works exist (the
    // minimum-works policy lives in CitizenArtLife.maybeExhibit).
    Art.createArtwork("Alice", "painting", 99, 1, "varrock", 1000);
    Art.createArtwork("Bob", "painting", 50, 0.5, "varrock", 2000);
    Art.createArtwork("Carol", "sculpture", 70, 0.7, "varrock", 2500);
    const ex = Art.hostExhibition("varrock", 3000);
    expect(ex).not.toBeNull();
    expect(ex.artworkIds).toHaveLength(3);
    expect(ex.kingdomId).toBe("varrock");
    // Best quality first.
    expect(ex.artworkIds[0]).toBe("art-1000-0"); // Alice's masterpiece

    // Cooldown blocks immediate re-exhibition.
    expect(Art.hostExhibition("varrock", 4000)).toBeNull();
    expect(Art.canExhibit("varrock", 4000)).toBe(false);
    // After cooldown, but no new works → null.
    const later = 3000 + 8 * 24 * 60 * 60 * 1000;
    expect(Art.hostExhibition("varrock", later)).toBeNull();
  });

  test("hostExhibition returns null when nothing new to exhibit", () => {
    expect(Art.hostExhibition("varrock", 1000)).toBeNull();
  });

  test("isMasterpiece detects quality 85+", () => {
    const master = Art.createArtwork("Alice", "painting", 99, 1, "varrock", 1000);
    const decent = Art.createArtwork("Bob", "painting", 50, 0.5, "varrock", 2000);
    expect(Art.isMasterpiece(master)).toBe(true);
    expect(Art.isMasterpiece(decent)).toBe(false);
    expect(Art.isMasterpiece(null)).toBe(false);
  });

  test("save persists and load restores", () => {
    Art.createArtwork("Alice", "painting", 50, 0.5, "varrock", 1000);
    expect(Art.save()).toBe(true);
    Art.resetForTests();
    Art._setSavePathForTests(TMP_SAVE);
    expect(Art.artworksOf("Alice")).toHaveLength(1);
  });
});
