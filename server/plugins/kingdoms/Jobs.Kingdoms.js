"use strict";

/**
 * Jobs.Kingdoms — the KINGDOM JOB BOARD (Phase 3, Jon 2026-10-11).
 *
 * The participation layer of the realm: ranks are status, offices are
 * scarce leadership, jobs are abundant labor. Any subject can take work
 * the realm actually needs, because every posting is generated from REAL
 * state — live wars (WarSupply demands, active war records), siege
 * damage (resolved siege records + Castle state), diplomacy (Relations),
 * and the wanted board (Bounties). Every completion is verified from
 * real state too: locations are read off the claimant, supply units are
 * counted from attributed deliveries, repairs remove real items and
 * restore real building tiers, sabotage runs the real Espionage path.
 *
 * Money is never invented: rewards are paid out of the posting
 * kingdom's treasury via KingdomStore.spendTax at completion time, and
 * the job does not complete when the coffers cannot pay.
 *
 * Job records live in store state.jobs.list:
 *   { id, kingdomId, type, title, detail, target, units, rewardGold,
 *     rewardInfluence, claimedBy, claimedAt, createdAt, expiresAt,
 *     status, deliveredUnits }
 * Daily claim caps live in state.jobs.caps: username -> type -> day ->
 * count.
 *
 * Delivery attribution: OfficeTools.deliverSupplies emits
 * kingdom:supply-delivered with { kingdomId, donor, itemId, units,
 * warKey } (warKey added at the delivery site for this board); the
 * handler in attach() credits the claimant's live supply/craft jobs via
 * recordDelivery(). CitizenJobs deliveries ride the same event.
 *
 * No ::commands, no LLM, no tick of its own — postings are ensured
 * lazily on read, the pattern WarSupply.ensureDemands uses.
 */

const Store = require("./KingdomStore");
const WarSupply = require("./WarSupply.Kingdoms");
const Relations = require("./Relations.Kingdoms");
const Influence = require("./Influence.Kingdoms");

const JOBS_CONFIG = {
  TTL_MS: 24 * 3600 * 1000,
  SUPPLY_UNITS: 100,
  CRAFT_UNITS: 100,
  STOCKPILE_UNITS: 100,
  ENVOY_GOODWILL: 6,
  SCOUT_RADIUS: 12,
  ENVOY_RADIUS: 12,
  SABOTAGE_RADIUS: 16,
  BUILDER_RADIUS: 16,
  WAR_EVENT_RADIUS: 40,
  REWARDS: {
    soldier: { gold: 400, influence: 6 },
    scout: { gold: 250, influence: 5 },
    supply: { gold: 300, influence: 4 },
    craft: { gold: 350, influence: 4 },
    builder: { gold: 300, influence: 4 },
    envoy: { gold: 300, influence: 6 },
    sabotage: { gold: 750, influence: 8 },
    bounty: { gold: 0, influence: 5 }, // gold comes from the wanted record
  },
  DAILY_CAPS: {
    soldier: 2,
    scout: 2,
    supply: 3,
    craft: 3,
    builder: 2,
    envoy: 1,
    sabotage: 1,
    bounty: 1,
  },
  /** Real items a builder hands over per repair (itemId -> count). */
  BUILDER_MATERIALS: { 1511: 10, 2351: 2 }, // logs, iron bars
  /** Categories whose goods are crafted (fletched arrows, runes, worked materials). */
  CRAFT_CATEGORIES: ["arrows", "runes", "materials"],
  COINS_ID: 995,
};

/** Capital tiles of the great powers (same table as Founding's muster points). */
const CAPITAL_TILES = {
  asgarnia: { x: 2964, y: 3378, z: 0 },
  misthalin: { x: 3165, y: 3485, z: 0 },
  kandarin: { x: 2660, y: 3290, z: 0 },
  morytania: { x: 3495, y: 3235, z: 0 },
  keldagrim: { x: 2855, y: 10200, z: 0 },
};

let jobCounter = 0;

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function jobsState(store) {
  const state = store.load();
  if (!state.jobs || typeof state.jobs !== "object") state.jobs = { list: [], caps: {} };
  if (!Array.isArray(state.jobs.list)) state.jobs.list = [];
  if (!state.jobs.caps || typeof state.jobs.caps !== "object") state.jobs.caps = {};
  return state.jobs;
}

function save(store) {
  try {
    store.save();
  } catch {
    // In-memory state still moved; the next save persists it.
  }
}

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? player?.username ?? null;
  } catch {
    return null;
  }
}

function kingdomOf(player) {
  try {
    return player?.getAttribute?.("kingdom:id") ?? null;
  } catch {
    return null;
  }
}

function locOf(player) {
  try {
    const loc = player?.getLocation?.();
    if (!loc) return null;
    const x = typeof loc.getX === "function" ? loc.getX() : loc.x;
    const y = typeof loc.getY === "function" ? loc.getY() : loc.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function kingdomName(store, id) {
  try {
    return store.getKingdom(id)?.name ?? String(id);
  } catch {
    return String(id);
  }
}

function warKeyFor(a, b) {
  return [String(a), String(b)].sort().join(":");
}

function dayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function capCount(store, username, type, now) {
  const caps = jobsState(store).caps;
  return caps[username]?.[type]?.[dayKey(now)] ?? 0;
}

function bumpCap(store, username, type, now) {
  const caps = jobsState(store).caps;
  if (!caps[username]) caps[username] = {};
  if (!caps[username][type]) caps[username][type] = {};
  const day = dayKey(now);
  caps[username][type][day] = (caps[username][type][day] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Siege damage (builder jobs) — read from resolved siege records + Castle
// ---------------------------------------------------------------------------

const REPAIRED_FLAG = "jobs:repaired-damage";

function repairedSet(store, kingdomId) {
  try {
    const flags = store.getKingdom(kingdomId)?.flags ?? {};
    const list = flags[REPAIRED_FLAG];
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

/** Unrepaired damage entries for a kingdom: [{ damageId, buildingId, entry }]. */
function damageEntries(store, kingdomId) {
  const state = store.load();
  const sieges = state.sieges ?? {};
  const repaired = repairedSet(store, kingdomId);
  const out = [];
  for (const siege of Object.values(sieges)) {
    if (!siege || siege.defenderKingdomId !== kingdomId) continue;
    if (!Array.isArray(siege.damaged) || siege.damaged.length === 0) continue;
    if (siege.status === "active") continue;
    for (const entry of siege.damaged) {
      const damageId = `${kingdomId}|${siege.resolvedAt ?? 0}|${entry}`;
      if (repaired.has(damageId)) continue;
      const buildingId = String(entry).split(":")[0];
      out.push({ damageId, buildingId, entry: String(entry) });
    }
  }
  return out;
}

/** Restore ONE damaged building tier in Castle state for a damage entry. */
function applyRepair(store, kingdomId, dmg) {
  const state = store.load();
  const castles = state.castles ?? {};
  const castle = castles[kingdomId];
  if (!castle || !dmg) return false;
  if (!castle.buildings || typeof castle.buildings !== "object") castle.buildings = {};
  const [, kind] = dmg.entry.split(":");
  if (kind === "destroyed") {
    if (castle.buildings[dmg.buildingId]) return false; // already rebuilt
    castle.buildings[dmg.buildingId] = { tier: 1, staff: [] };
  } else {
    const b = castle.buildings[dmg.buildingId];
    if (!b) return false;
    const damagedTier = Number(String(kind).replace("tier-", ""));
    if (Number.isFinite(damagedTier) && b.tier !== damagedTier) return false; // already fixed
    if (b.tier >= 3) return false;
    b.tier += 1;
  }
  const repaired = repairedSet(store, kingdomId);
  repaired.add(dmg.damageId);
  try {
    store.setFlag(kingdomId, REPAIRED_FLAG, [...repaired]);
  } catch {
    // Flag write is the record; without it the job must not complete.
    return false;
  }
  return true;
}

/** Remove real items from a claimant's inventory (verified amounts). */
function removeItems(player, materials) {
  const inv = player?.getInventory?.();
  if (!inv) return false;
  for (const [idStr, count] of Object.entries(materials)) {
    const id = Number(idStr);
    if ((inv.getAmount?.(id) ?? 0) < count) return false;
  }
  for (const [idStr, count] of Object.entries(materials)) {
    const id = Number(idStr);
    const before = inv.getAmount?.(id) ?? 0;
    try {
      if (typeof inv.deleteNumber === "function") inv.deleteNumber(id, count);
      else if (typeof inv.delete === "function") inv.delete(id, count);
      else return false;
    } catch {
      return false;
    }
    if ((inv.getAmount?.(id) ?? 0) !== before - count) return false;
  }
  try {
    inv.refreshItems?.();
  } catch {
    // Cosmetic.
  }
  return true;
}

// ---------------------------------------------------------------------------
// Posting generation — from real state, lazily ensured on read
// ---------------------------------------------------------------------------

function makeJob(store, kingdomId, type, title, detail, target, units, now) {
  const rewards = JOBS_CONFIG.REWARDS[type] ?? { gold: 0, influence: 0 };
  return {
    id: `job-${now.toString(36)}-${++jobCounter}`,
    kingdomId,
    type,
    title,
    detail,
    target: target ?? {},
    units: units ?? 0,
    rewardGold: rewards.gold,
    rewardInfluence: rewards.influence,
    claimedBy: null,
    claimedAt: null,
    createdAt: now,
    expiresAt: now + JOBS_CONFIG.TTL_MS,
    status: "open",
    deliveredUnits: 0,
  };
}

function hasLiveJob(list, kingdomId, type, match) {
  return list.some(
    (j) =>
      j &&
      j.kingdomId === kingdomId &&
      j.type === type &&
      (j.status === "open" || j.status === "claimed") &&
      match(j)
  );
}

/**
 * Ensure the board for a kingdom reflects real state. Returns all live
 * (open or claimed) postings for the kingdom. Idempotent: live postings
 * are never duplicated, expired ones are retired.
 */
function ensureJobs(kingdomId, store, now = Date.now()) {
  if (!kingdomId || !store) return [];
  const js = jobsState(store);
  let dirty = false;
  // Retire expired postings.
  for (const job of js.list) {
    if (job && job.status !== "done" && job.status !== "failed" && job.expiresAt && now > job.expiresAt) {
      job.status = "expired";
      job.claimedBy = job.claimedBy ?? null;
      dirty = true;
    }
  }

  let wars = [];
  try {
    wars = (store.getActiveWars?.() ?? []).filter(
      (w) => w && (w.attackerId === kingdomId || w.defenderId === kingdomId)
    );
  } catch {
    wars = [];
  }
  const atWar = wars.length > 0;
  const liveWarKeys = new Set(wars.map((w) => warKeyFor(w.attackerId, w.defenderId)));

  // Retire open postings whose war has ended.
  for (const job of js.list) {
    if (
      job &&
      job.kingdomId === kingdomId &&
      job.status === "open" &&
      job.target?.warKey &&
      !liveWarKeys.has(job.target.warKey)
    ) {
      job.status = "expired";
      dirty = true;
    }
  }

  const post = (type, title, detail, target, units, match) => {
    if (hasLiveJob(js.list, kingdomId, type, match)) return;
    js.list.push(makeJob(store, kingdomId, type, title, detail, target, units, now));
    dirty = true;
  };

  for (const war of wars) {
    const foe = war.attackerId === kingdomId ? war.defenderId : war.attackerId;
    const foeName = kingdomName(store, foe);
    const key = warKeyFor(kingdomId, foe);
    post(
      "soldier",
      `Soldier for ${kingdomName(store, kingdomId)}`,
      `Take the field against ${foeName}. Your pay is settled when a battle or siege you stood at is decided.`,
      { foe, warKey: key },
      0,
      (j) => j.target?.warKey === key
    );
    const foeTile = CAPITAL_TILES[foe];
    if (foeTile) {
      post(
        "scout",
        `Scout ${foeName}`,
        `Reach the approaches of ${foeName}'s capital and report back.`,
        { foe, warKey: key, tile: foeTile },
        0,
        (j) => j.target?.foe === foe
      );
    }
    post(
      "sabotage",
      `Sabotage the ${foeName} war effort`,
      `Slip to the ${foeName} capital and burn their war stock. If you are caught, the bounty is theirs to post.`,
      { foe, warKey: key, tile: CAPITAL_TILES[foe] ?? null },
      0,
      (j) => j.target?.foe === foe
    );
  }

  // Supply + craft contracts from live WarSupply demands.
  try {
    WarSupply.ensureDemands(kingdomId, wars, store);
    const status = WarSupply.supplyStatus(kingdomId, store);
    for (const demand of status) {
      for (const cat of demand.categories ?? []) {
        const remaining = Math.max(0, (cat.quota ?? 0) - (cat.stock ?? 0));
        if (remaining <= 0) continue;
        const isCraft = JOBS_CONFIG.CRAFT_CATEGORIES.includes(cat.cat);
        const type = isCraft ? "craft" : "supply";
        const units = Math.min(remaining, isCraft ? JOBS_CONFIG.CRAFT_UNITS : JOBS_CONFIG.SUPPLY_UNITS);
        post(
          type,
          `${isCraft ? "Craft" : "Supply"}: ${cat.label} for the war on ${demand.foeName}`,
          `Deliver ${units} units of ${cat.label.toLowerCase()} to the war effort against ${demand.foeName} through the donation chest.`,
          { warKey: demand.warKey, category: cat.cat, foe: demand.foe },
          units,
          (j) => j.target?.warKey === demand.warKey && j.target?.category === cat.cat
        );
      }
    }
  } catch {
    // WarSupply unavailable: the rest of the board still posts.
  }

  // Peacetime standing contract: stock the war chest.
  if (!atWar) {
    post(
      "supply",
      "Stock the war chest",
      `Deliver ${JOBS_CONFIG.STOCKPILE_UNITS} units of provisions or war goods against the quartermaster's standing order.`,
      { stockpile: true, category: null },
      JOBS_CONFIG.STOCKPILE_UNITS,
      (j) => j.target?.stockpile === true
    );
  }

  // Envoy missions (and ultimatum deliveries) to non-allied kingdoms.
  try {
    for (const other of store.getKingdoms?.() ?? []) {
      if (!other || other.id === kingdomId) continue;
      const tile = CAPITAL_TILES[other.id];
      if (!tile) continue;
      let allied = false;
      try {
        allied = store.isAllied?.(kingdomId, other.id) === true;
      } catch {
        allied = false;
      }
      if (allied) continue;
      const warBetween = wars.some(
        (w) =>
          (w.attackerId === kingdomId && w.defenderId === other.id) ||
          (w.attackerId === other.id && w.defenderId === kingdomId)
      );
      if (warBetween) continue;
      let relation = null;
      try {
        relation = Relations.relationOf(kingdomId, other.id, store);
      } catch {
        relation = null;
      }
      const ultimatum =
        relation === Relations.RELATION_TENSE || relation === Relations.RELATION_HOSTILE;
      post(
        "envoy",
        ultimatum ? `Deliver an ultimatum to ${other.name}` : `Envoy to ${other.name}`,
        ultimatum
          ? `Carry ${kingdomName(store, kingdomId)}'s ultimatum to the court of ${other.name}. Their answer will chill the border.`
          : `Carry greetings from ${kingdomName(store, kingdomId)} to the court of ${other.name} and warm the border.`,
        { foe: other.id, tile, variant: ultimatum ? "ultimatum" : "envoy" },
        0,
        (j) => j.target?.foe === other.id
      );
    }
  } catch {
    // Diplomacy reads failed: envoys simply don't post this pass.
  }

  // Builder jobs from real siege damage.
  try {
    for (const dmg of damageEntries(store, kingdomId)) {
      post(
        "builder",
        `Repair the ${dmg.buildingId}`,
        `Siege damage left the ${dmg.buildingId} broken. Bring logs and iron bars to the capital and restore one tier.`,
        { damageId: dmg.damageId, buildingId: dmg.buildingId, tile: CAPITAL_TILES[kingdomId] ?? null },
        0,
        (j) => j.target?.damageId === dmg.damageId
      );
    }
  } catch {
    // Damage reads failed: no builder postings this pass.
  }

  if (dirty) save(store);
  return js.list.filter(
    (j) => j && j.kingdomId === kingdomId && (j.status === "open" || j.status === "claimed")
  );
}

// ---------------------------------------------------------------------------
// Board reads
// ---------------------------------------------------------------------------

/** Bounty pseudo-postings from the wanted board (claimable contracts). */
function bountyPostings(store) {
  try {
    const Bounties = require("./Bounties.Kingdoms");
    return Bounties.listWanted(store).map((rec) => ({
      id: bountyJobId(rec),
      kingdomId: rec.kingdomId,
      type: "bounty",
      title: `Wanted: ${rec.username}`,
      detail: `Wanted by ${kingdomName(store, rec.kingdomId)} for ${rec.crime} (${rec.crimes} offense${rec.crimes === 1 ? "" : "s"}). Collect by the kill — the contract pays from the court's escrow.`,
      target: { username: rec.username, crime: rec.crime },
      units: 0,
      rewardGold: rec.amount,
      rewardInfluence: JOBS_CONFIG.REWARDS.bounty.influence,
      claimedBy: null,
      claimedAt: null,
      createdAt: rec.postedAt,
      expiresAt: null,
      status: "open",
      deliveredUnits: 0,
      open: true,
    }));
  } catch {
    return [];
  }
}

function bountyJobId(rec) {
  return `bounty:${rec.kingdomId}:${String(rec.username).toLowerCase()}`;
}

/** The board a subject sees: their kingdom's postings + all bounties. */
function boardFor(kingdomId, store, now = Date.now()) {
  const mine = kingdomId ? ensureJobs(kingdomId, store, now) : [];
  const open = mine.filter((j) => j.status === "open");
  return [...open, ...bountyPostings(store)];
}

function claimsOf(username, store) {
  if (!username || !store) return [];
  return jobsState(store).list.filter(
    (j) => j && j.status === "claimed" && j.claimedBy && norm(j.claimedBy) === norm(username)
  );
}

function norm(name) {
  return String(name ?? "").toLowerCase().trim();
}

function findJob(store, jobId) {
  return jobsState(store).list.find((j) => j && j.id === jobId) ?? null;
}

function holdsBountyContract(username, wantedRecord, store) {
  if (!username || !wantedRecord || !store) return false;
  return jobsState(store).list.some(
    (j) =>
      j &&
      j.type === "bounty" &&
      j.status === "claimed" &&
      norm(j.claimedBy) === norm(username) &&
      norm(j.target?.username) === norm(wantedRecord.username) &&
      j.kingdomId === wantedRecord.kingdomId
  );
}

// ---------------------------------------------------------------------------
// Claim / abandon
// ---------------------------------------------------------------------------

function claim(player, jobId, store, now = Date.now()) {
  const fail = (reason) => ({ ok: false, reason });
  if (!player || !jobId || !store) return fail("missing-params");
  const username = usernameOf(player);
  if (!username) return fail("no-username");
  const claimantKingdom = kingdomOf(player);

  // Bounty contracts are synthesized from the wanted board.
  if (String(jobId).startsWith("bounty:")) {
    let rec = null;
    try {
      const Bounties = require("./Bounties.Kingdoms");
      rec =
        Bounties.listWanted(store).find((r) => bountyJobId(r) === jobId) ?? null;
    } catch {
      rec = null;
    }
    if (!rec) return fail("bounty-gone");
    if (norm(rec.username) === norm(username)) return fail("cannot-hunt-self");
    if (
      jobsState(store).list.some(
        (j) => j && j.type === "bounty" && j.status === "claimed" && norm(j.claimedBy) === norm(username)
      )
    ) {
      return fail("already-hunting");
    }
    if (capCount(store, username, "bounty", now) >= JOBS_CONFIG.DAILY_CAPS.bounty) {
      return fail("daily-cap");
    }
    const job = {
      id: `job-${now.toString(36)}-${++jobCounter}`,
      kingdomId: rec.kingdomId,
      type: "bounty",
      title: `Wanted: ${rec.username}`,
      detail: `Hunt ${rec.username}, wanted by ${kingdomName(store, rec.kingdomId)} for ${rec.crime}.`,
      target: { username: rec.username, crime: rec.crime },
      units: 0,
      rewardGold: rec.amount,
      rewardInfluence: JOBS_CONFIG.REWARDS.bounty.influence,
      claimedBy: username,
      claimedAt: now,
      createdAt: now,
      expiresAt: now + JOBS_CONFIG.TTL_MS,
      status: "claimed",
      deliveredUnits: 0,
      open: true,
    };
    jobsState(store).list.push(job);
    bumpCap(store, username, "bounty", now);
    save(store);
    return { ok: true, job };
  }

  const job = findJob(store, jobId);
  if (!job) return fail("no-such-job");
  if (job.status !== "open") return fail("already-claimed");
  if (job.expiresAt && now > job.expiresAt) {
    job.status = "expired";
    save(store);
    return fail("expired");
  }
  if (!job.open && claimantKingdom !== job.kingdomId) return fail("not-your-kingdom");
  if (capCount(store, username, job.type, now) >= (JOBS_CONFIG.DAILY_CAPS[job.type] ?? 3)) {
    return fail("daily-cap");
  }
  job.claimedBy = username;
  job.claimedAt = now;
  job.status = "claimed";
  job.deliveredUnits = job.deliveredUnits ?? 0;
  bumpCap(store, username, job.type, now);
  save(store);
  return { ok: true, job };
}

function abandon(player, jobId, store) {
  const fail = (reason) => ({ ok: false, reason });
  const username = usernameOf(player);
  if (!username || !jobId || !store) return fail("missing-params");
  const job = findJob(store, jobId);
  if (!job || job.status !== "claimed" || norm(job.claimedBy) !== norm(username)) {
    return fail("not-your-claim");
  }
  job.status = "open";
  job.claimedBy = null;
  job.claimedAt = null;
  job.deliveredUnits = 0;
  save(store);
  return { ok: true, job };
}

// ---------------------------------------------------------------------------
// Payment + completion core
// ---------------------------------------------------------------------------

/**
 * Pay a completed job from the posting kingdom's treasury. Returns the
 * gold actually paid. When player is null (an offline citizen whose
 * service was verified from militia state), the job completes unpaid —
 * coins are never invented and never vanish.
 */
function payReward(player, job, store) {
  if (!player) return 0;
  let paid = 0;
  if (job.rewardGold > 0) {
    let ok = false;
    try {
      ok = store.spendTax(job.kingdomId, job.rewardGold) === true;
    } catch {
      ok = false;
    }
    if (!ok) return -1; // treasury cannot pay: do not complete
    try {
      const inv = player.getInventory?.();
      if (inv && typeof inv.adds === "function") inv.adds(JOBS_CONFIG.COINS_ID, job.rewardGold);
      paid = job.rewardGold;
    } catch {
      // Refund the treasury: the purse could not take the coins.
      try {
        store.grantTax(job.kingdomId, job.rewardGold);
      } catch {
        // Accounting loss is logged by the caller path; never throw here.
      }
      return -1;
    }
  }
  if (job.rewardInfluence > 0) {
    try {
      Influence.addInfluence(player, job.kingdomId, job.rewardInfluence, `job-${job.type}`);
    } catch {
      // Influence is standing, not the wage; the coins already moved.
    }
  }
  return paid;
}

function completeClaimed(job, store, player) {
  const paid = payReward(player, job, store);
  if (paid < 0) return { ok: false, reason: "treasury-cannot-pay" };
  job.status = "done";
  job.completedAt = Date.now();
  job.paidGold = paid;
  save(store);
  return { ok: true, job, paidGold: paid };
}

/**
 * Verify + complete a claimed job from real state. Soldier and bounty
 * jobs complete through events (war resolution / the death hook), never
 * through this button path.
 */
function complete(player, jobId, store) {
  const fail = (reason) => ({ ok: false, reason });
  const username = usernameOf(player);
  if (!username || !jobId || !store) return fail("missing-params");
  const job = findJob(store, jobId);
  if (!job || job.status !== "claimed" || norm(job.claimedBy) !== norm(username)) {
    return fail("not-your-claim");
  }
  const claimantKingdom = kingdomOf(player) ?? job.kingdomId;
  const loc = locOf(player);

  switch (job.type) {
    case "soldier":
      return fail("settled-on-the-field");
    case "bounty":
      return fail("settled-by-the-kill");
    case "scout": {
      if (!loc || !job.target?.tile) return fail("cannot-verify");
      if (chebyshev(loc, job.target.tile) > JOBS_CONFIG.SCOUT_RADIUS) {
        return fail("not-at-target");
      }
      return completeClaimed(job, store, player);
    }
    case "envoy": {
      if (!loc || !job.target?.tile) return fail("cannot-verify");
      if (chebyshev(loc, job.target.tile) > JOBS_CONFIG.ENVOY_RADIUS) {
        return fail("not-at-target");
      }
      try {
        const delta =
          job.target.variant === "ultimatum"
            ? Relations.GOODWILL_ULTIMATUM
            : JOBS_CONFIG.ENVOY_GOODWILL;
        Relations.addGoodwill(claimantKingdom, job.target.foe, delta, store);
        save(store);
      } catch {
        return fail("court-unreachable");
      }
      return completeClaimed(job, store, player);
    }
    case "supply":
    case "craft": {
      if ((job.deliveredUnits ?? 0) < job.units) return fail("deliveries-short");
      return completeClaimed(job, store, player);
    }
    case "builder": {
      if (!loc || !job.target?.tile) return fail("cannot-verify");
      if (chebyshev(loc, job.target.tile) > JOBS_CONFIG.BUILDER_RADIUS) {
        return fail("not-at-target");
      }
      const dmg = damageEntries(store, job.kingdomId).find(
        (d) => d.damageId === job.target.damageId
      );
      if (!dmg) return fail("damage-gone");
      if (!removeItems(player, JOBS_CONFIG.BUILDER_MATERIALS)) {
        return fail("materials-missing");
      }
      if (!applyRepair(store, job.kingdomId, dmg)) return fail("repair-failed");
      save(store);
      return completeClaimed(job, store, player);
    }
    case "sabotage": {
      if (!loc || !job.target?.tile) return fail("cannot-verify");
      if (chebyshev(loc, job.target.tile) > JOBS_CONFIG.SABOTAGE_RADIUS) {
        return fail("not-at-target");
      }
      let result = null;
      try {
        const Espionage = require("./Espionage.Kingdoms");
        result = Espionage.sabotage(player, claimantKingdom, job.target.foe, store);
      } catch {
        return fail("sabotage-unavailable");
      }
      if (!result?.ok) return fail(result?.reason ?? "sabotage-failed");
      if (result.caught) {
        // Espionage already applied hatred + the victim's bounty.
        job.status = "failed";
        job.completedAt = Date.now();
        save(store);
        return { ok: false, reason: "caught", job };
      }
      return completeClaimed(job, store, player);
    }
    default:
      return fail("unknown-type");
  }
}

// ---------------------------------------------------------------------------
// Delivery attribution (kingdom:supply-delivered)
// ---------------------------------------------------------------------------

/**
 * Credit delivered units to the donor's live supply/craft claims.
 * Called by the kingdom:supply-delivered event handler (and directly by
 * tests). Deliveries are attributed per claim: only units delivered
 * AFTER the claim, to the job's kingdom, in the job's category (and war,
 * when the job names one) count.
 */
function recordDelivery(username, kingdomId, cat, units, warKey, store) {
  if (!username || !kingdomId || !store || !(units > 0)) return 0;
  let credited = 0;
  for (const job of jobsState(store).list) {
    if (!job || job.status !== "claimed") continue;
    if (norm(job.claimedBy) !== norm(username)) continue;
    if (job.kingdomId !== kingdomId) continue;
    if (job.type !== "supply" && job.type !== "craft") continue;
    if (job.target?.stockpile) {
      // Peacetime stockpile contracts take any category.
    } else {
      if (job.target?.category && cat && job.target.category !== cat) continue;
      if (job.target?.warKey && warKey && job.target.warKey !== warKey) continue;
    }
    job.deliveredUnits = (job.deliveredUnits ?? 0) + units;
    credited += units;
  }
  if (credited > 0) save(store);
  return credited;
}

// ---------------------------------------------------------------------------
// Soldier completion from war events (Battles / Siege hooks)
// ---------------------------------------------------------------------------

/**
 * Settle soldier jobs after a battle or siege resolves. Claimants of
 * soldier jobs for either belligerent complete when they stood at the
 * field: online players within WAR_EVENT_RADIUS of the site (via the
 * caller's worldLookup), and citizen claimants by their militia
 * enlistment. Fail-safe by construction — callers wrap in try/catch and
 * this function never throws.
 */
function onWarEventResolved(event) {
  const out = [];
  try {
    const { kind, attackerId, defenderId, site, store, worldLookup } = event ?? {};
    if (!attackerId || !defenderId || !store) return out;
    let Militia = null;
    try {
      Militia = require("./Militia.Kingdoms");
    } catch {
      Militia = null;
    }
    for (const job of [...jobsState(store).list]) {
      if (!job || job.type !== "soldier" || job.status !== "claimed") continue;
      if (job.kingdomId !== attackerId && job.kingdomId !== defenderId) continue;
      const foe = job.kingdomId === attackerId ? defenderId : attackerId;
      if (job.target?.foe && job.target.foe !== foe) continue;
      let player = null;
      try {
        player = worldLookup?.(job.claimedBy) ?? null;
      } catch {
        player = null;
      }
      let present = false;
      if (player && site) {
        const loc = locOf(player);
        if (loc && chebyshev(loc, site) <= JOBS_CONFIG.WAR_EVENT_RADIUS) present = true;
      }
      if (!present && Militia) {
        try {
          if (Militia.isMilitia(job.claimedBy)) present = true;
        } catch {
          // Enlistment read failed: presence unproven.
        }
      }
      if (!present) continue;
      const res = completeClaimed(job, store, player);
      if (res.ok) out.push({ jobId: job.id, username: job.claimedBy, kind, paidGold: res.paidGold });
    }
  } catch {
    // War resolution must never break on jobs.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Death hook — bounty collection
// ---------------------------------------------------------------------------

/** Credit coins to a killer's purse (real inventory API). */
function creditCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv || typeof inv.adds !== "function" || !(amount > 0)) return false;
    inv.adds(JOBS_CONFIG.COINS_ID, amount);
    return true;
  } catch {
    return false;
  }
}

/**
 * onPlayerDeath handler: the engine's death event names the killer
 * ({ player, killer } — the same payload Tension.Kingdoms reads). When
 * the dead is wanted and the killer holds the contract, the bounty is
 * collected from the record's escrow and paid to the killer's purse.
 */
function onPlayerDeath({ player, killer } = {}) {
  try {
    const deadName = usernameOf(player);
    const killerName = usernameOf(killer);
    if (!deadName || !killerName) return;
    const Bounties = require("./Bounties.Kingdoms");
    const res = Bounties.collect(deadName, killerName, Store);
    if (!res) return;
    creditCoins(killer, res.payout);
    const claim = jobsState(Store).list.find(
      (j) =>
        j &&
        j.type === "bounty" &&
        j.status === "claimed" &&
        norm(j.claimedBy) === norm(killerName) &&
        norm(j.target?.username) === norm(deadName)
    );
    if (claim) {
      claim.status = "done";
      claim.completedAt = Date.now();
      claim.paidGold = res.payout;
      if (claim.rewardInfluence > 0) {
        try {
          Influence.addInfluence(killer, claim.kingdomId, claim.rewardInfluence, "job-bounty");
        } catch {
          // Standing is a courtesy; the coin already moved.
        }
      }
      save(Store);
    }
    try {
      killer.sendMessage?.(
        `[Bounty] You collected ${res.payout}c on the head of ${deadName}. The court's escrow is settled.`
      );
    } catch {
      // Cosmetic.
    }
  } catch {
    // The death path must never break on the bounty board.
  }
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

function onSupplyDelivered(payload) {
  try {
    const { kingdomId, player, donor, itemId, units, warKey } = payload ?? {};
    const username = donor ?? usernameOf(player);
    if (!username || !kingdomId || !(units > 0)) return;
    let cat = null;
    try {
      cat = WarSupply.WAR_SUPPLY_ITEMS[itemId]?.cat ?? null;
    } catch {
      cat = null;
    }
    if (!cat) cat = "food"; // OfficeTools' standing-order items are provisions.
    recordDelivery(username, kingdomId, cat, units, warKey ?? null, Store);
  } catch {
    // Attribution must never break a delivery.
  }
}

function attachJobs(api) {
  try {
    api.onCustomEvent("kingdom:supply-delivered", onSupplyDelivered);
  } catch {
    // Event bus unavailable: deliveries still land, jobs just don't credit.
  }
  try {
    api.onPlayerDeath(onPlayerDeath);
  } catch {
    // Death hook unavailable in this harness.
  }
  console.info("[jobs] kingdom job board armed — work from real state, pay from real treasuries");
}

module.exports = attachJobs;
module.exports.attachJobs = attachJobs;
module.exports.JOBS_CONFIG = JOBS_CONFIG;
module.exports.CAPITAL_TILES = CAPITAL_TILES;
module.exports.ensureJobs = ensureJobs;
module.exports.boardFor = boardFor;
module.exports.claimsOf = claimsOf;
module.exports.claim = claim;
module.exports.complete = complete;
module.exports.abandon = abandon;
module.exports.recordDelivery = recordDelivery;
module.exports.holdsBountyContract = holdsBountyContract;
module.exports.onWarEventResolved = onWarEventResolved;
module.exports.onPlayerDeath = onPlayerDeath;
module.exports.onSupplyDelivered = onSupplyDelivered;
module.exports._test = { damageEntries, applyRepair, jobsState, dayKey, chebyshev };
