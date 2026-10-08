"use strict";

/**
 * CitizenMarketStalls2 — the stallfolk: amateur market-stall keepers under
 * the professional stall merchants. Barrow-folk who wheel patched goods in
 * a barrow, blanket-folk who spread secondhand wares on a blanket, and
 * crate-folk who stack mended tools on upturned crates. Commoners who live
 * off the rough provisional-stall economy — the scrappy amateur stall layer
 * under the professional market stalls.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived stall types (~35% nominal share of commoners,
 *   post-exclusion), per-day fringe stall pitches (kingdom-preferred,
 *   seeded per day), per-day provisional goods, per-kingdom-per-day
 *   wheel-off / moved-along set-pieces plus a once-per-pitch-per-day
 *   haggle-crowd moment (journaled + rumor-seeded), and a read-only
 *   market-wares bridge that lets stallfolk small talk name what the real
 *   CitizenMarketStalls day wares actually are. Morning setup flavor before
 *   10:00, midday cries after.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 07:00-18:00 local): scripted setup flavor, stall cries, market-wares
 * small talk, the barrow wheel coming off, the guard moving the blanket
 * along, the haggle crowd gathering round a pitch. Real sales and haggling
 * are LLM tier — this module only tracks state, timers and the visible
 * street scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the hawkerfolk block.
 * Plain-node testable: CitizenMarketStalls2.test.js.
 *
 * No overlap (by design):
 *   - CitizenMarketStalls (master) owns the PROFESSIONAL goods trade:
 *     claimed stall pitches, day wares, shop trade, haggling, restock.
 *     The master claims by citizen role — its claim predicate is
 *     role === "merchant" (see CitizenMarketStalls.eligibleForStall). There
 *     is no named claimed-type function to bridge, so the exclusion is the
 *     role gate: stallfolk are commoners ONLY, checked by isProStallMerchant
 *     BEFORE the share roll — a citizen is never both a professional stall
 *     merchant and stallfolk. The stallfolk never touch the master's
 *     `citizens:market-wares` attribute or run the Trade interface.
 *   - CitizenHawkers2 owns amateur BASKET-cryers with no stalls — excluded
 *     via the real claim function (Hawkers2.hawkerTypeOf) BEFORE the share
 *     roll: a citizen who cries from a basket never also keeps a
 *     provisional stall. Stallfolk keep a stall and cry from it; hawkers
 *     cry with no stall at all.
 *   - CitizenMessengers own proclamations of news — stallfolk cry GOODS
 *     only, never news or decrees.
 *   - CitizenBards/street performers own entertainment — a stall crowd is
 *     commerce (hagglers gathering), never a show.
 *   - CitizenWatchmen/CitizenGuards own the watch — stallfolk trade and
 *     get moved along, never patrol or stand guard.
 */

// === Tuning: all magic numbers here ===
const STALL_RADIUS = 14; // tiles — close enough to hear
const STALL_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const STALL_CHANCE = 0.15; // per eligible citizen per tick
const STALL_SHARE = 35; // ~35% nominal share of commoners (post-exclusion)
const WHEEL_OFF_CHANCE = 0.06; // ~6% per kingdom per day: the barrow wheel comes off
const MOVED_ALONG_CHANCE = 0.07; // ~7% per kingdom per day: a guard moves the pitch along
const STALL_CROWD_CHANCE = 0.08; // ~8% per stall pitch per day: a haggle crowd gathers
const WORK_START_HOUR = 7; // 07:00 server local time (set up with the morning hawkers)
const WORK_END_HOUR = 18; // 18:00 server local time (pack before the pro stalls wind down at 19)
const SETUP_CUTOFF_HOUR = 10; // before 10:00: setup flavor instead of midday cries

// === Top-level safeRequires (no lazy requires in the per-citizen path).
// The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProMarket = safeRequire("./CitizenMarketStalls"); // master: real day wares, read-only
const Hawkers2 = safeRequire("./CitizenHawkers2"); // basket-cryers: real claim fn, exclusion
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");

// === Stall types ===
const BARROW_FOLK = "barrow-stallfolk";
const BLANKET_FOLK = "blanket-stallfolk";
const CRATE_FOLK = "crate-stallfolk";
const STALL_TYPES = [BARROW_FOLK, BLANKET_FOLK, CRATE_FOLK];
const STALL_WEIGHTS = {
  [BARROW_FOLK]: 40,
  [BLANKET_FOLK]: 35,
  [CRATE_FOLK]: 25,
};

// === Fringe stalls — market edges, ditch corners, shack rows and low wells.
// Provisional pitches, NOT the professional ring: no awning, no counter, and
// deliberately off the pro merchants' patch. ===
const STALLS = [
  { name: "Varrock market fringe", kingdom: "misthalin" },
  { name: "Lumbridge ditch corner", kingdom: "misthalin" },
  { name: "Falador park edge", kingdom: "asgarnia" },
  { name: "Port Sarim customs corner", kingdom: "asgarnia" },
  { name: "Ardougne poor gate", kingdom: "kandarin" },
  { name: "Catherby net-mending corner", kingdom: "kandarin" },
  { name: "Keldagrim tier backstep", kingdom: "keldagrim" },
  { name: "Dorgeshuun stair landing", kingdom: "keldagrim" },
  { name: "Canifis graveyard wall", kingdom: "morytania" },
  { name: "Burgh de Rott shack row", kingdom: "morytania" },
  { name: "Al Kharid souk fringe", kingdom: "kharidian" },
  { name: "Pollnivneach low well", kingdom: "kharidian" },
];

// === The provisional goods — coarse, cheap, patched and secondhand. Plain
// flavor strings, deliberately nothing a professional stall would stock. ===
const GOODS = {
  [BARROW_FOLK]: [
    "patched shoes",
    "darned cloaks",
    "bent nails",
    "day-old bread",
    "secondhand pots",
    "chipped crockery",
  ],
  [BLANKET_FOLK]: [
    "worn books",
    "brass buttons",
    "lucky stones",
    "bone combs",
    "tarnished rings",
    "old maps",
  ],
  [CRATE_FOLK]: [
    "repaired tools",
    "sharpened knives",
    "re-strung bows",
    "patched sacks",
    "oiled lanterns",
    "re-soled sandals",
  ],
};

// === Line pools — all scripted, zero LLM. ===

// Morning setup flavor: before 10:00 the stallfolk are still setting up.
const SETUP_LINES = [
  "*heaves the barrow into place*",
  "*shakes the blanket out on the cobbles*",
  "*stacks the crates just so*",
  "*unfolds the blanket, goods and all*",
  "*sets the barrow down with a grunt*",
  "*wipes the crates down and lays out the goods*",
];

// The stall cries: one pool per stall type.
const STALL_LINES = {
  [BARROW_FOLK]: [
    "{goods}! Patched and priced, friend!",
    "Barrow's full — {goods}, come and look!",
    "{goods}, good as new — well, good as nearly!",
    "Step up to the barrow — {goods} today!",
    "Cheap {goods}! The barrow won't stand all day!",
  ],
  [BLANKET_FOLK]: [
    "{goods} on the blanket — take your pick!",
    "Spread out the blanket: {goods}, friend!",
    "{goods}, every one worth a look!",
    "Blanket's laid — {goods} for a copper or two!",
    "Come see the {goods} — blanket's right here!",
  ],
  [CRATE_FOLK]: [
    "{goods}! Mended proper, friend!",
    "Crates are stacked — {goods}, good as any stall's!",
    "{goods}, fixed by my own hands!",
    "Up off the crates — {goods}, priced to move!",
    "Fine {goods} — the crates say so!",
  ],
};

// Wheel-off set-piece: the barrow loses a wheel.
const WHEEL_OFF_LINES = [
  "The barrow wheel's come off again! Help me, someone!",
  "(the barrow tips) Oh no — not the wheel! Not again!",
  "Wheel's off — the whole barrow's down! Lend a hand!",
];

// Moved-along set-piece: a guard clears the provisional pitch.
const MOVED_ALONG_LINES = [
  "The guard says move the blanket along — (they drag it aside)",
  "(a guard taps their shoulder) Move along, they said. Pack the crates.",
  "Moved along again — the pitch goes where the guards say.",
  "Guard's coming — fold the blanket, fold it quick!",
];

// Haggle-crowd moment: once per pitch per day, buyers gather round.
const CROWD_LINES = [
  "A haggle crowd gathers round {place} — coppers flying!",
  "The folk crowd the {goods} — elbows in, friend!",
  "Look at them swarm — the crowd knows the cheapest pitch at {place}!",
  "{goods} — get them while the crowd hasn't bought me out!",
];

// Market-bridge small talk — names the real professional market day wares,
// read-only from CitizenMarketStalls, so stallfolk talk stays consistent
// with the actual market.
const MARKET_TALK_LINES = [
  "The big stalls sell {ware} up the lane — mine's the cheap end, friend.",
  "{ware} at the proper stalls, {goods} at my pitch — your coin decides!",
  "Saw {ware} on the market stalls — aye, mine's half the price!",
  "The market's flush with {ware} today — but my {goods} won't break you!",
];

// Today's task lines per type (for journals).
const DAILY_TASK_LINES = {
  [BARROW_FOLK]: [
    "wheeled the barrow to {place}",
    "sold off the barrow at {place}",
    "hawked patched goods at {place}",
  ],
  [BLANKET_FOLK]: [
    "spread the blanket at {place}",
    "sold secondhand wares at {place}",
    "worked the blanket pitch at {place}",
  ],
  [CRATE_FOLK]: [
    "stacked the crates at {place}",
    "sold mended tools at {place}",
    "worked the crate stall at {place}",
  ],
};

// === Cooldown state (monotonic Date.now() timestamps) ===
const lastFiredByCitizen = new Map(); // username -> timestamp
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash of a string. */
function hashStr(s) {
  s = String(s ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Fill {slots} in a template string. */
function fill(template, slots) {
  let out = String(template);
  for (const [k, v] of Object.entries(slots ?? {})) {
    out = out.split("{" + k + "}").join(String(v));
  }
  return out;
}

/** "IRON_SWORD" -> "iron sword". */
function prettyWare(s) {
  return String(s ?? "").toLowerCase().replace(/_/g, " ").trim();
}

/** Weighted pick of a stall type from a 0..99 roll. */
function stallTypeFromRoll(roll) {
  let acc = 0;
  for (const t of STALL_TYPES) {
    acc += STALL_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return BARROW_FOLK;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** True during amateur market hours (07:00-18:00 server local time). */
function isWorkHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
}

/** True only for real human players (not bots, not logged-out). */
function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch {
    return false;
  }
}

/** Cheap Chebyshev distance check (same plane). */
function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch {
    return false;
  }
}

/** Cheap rng from a seed (mulberry-ish LCG). */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Chance check with injected rng. */
function chance(rng, p) {
  return rng() < p;
}

/** Normalized username via CitizenBonds (fallback: lowercase). */
function normalizeName(name) {
  try {
    if (Bonds && typeof Bonds.normalizeName === "function") return Bonds.normalizeName(name);
  } catch { /* fall through */ }
  return String(name ?? "").toLowerCase();
}

// ============================================================================
// Stallfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * True when this record is claimed by the MASTER CitizenMarketStalls
 * professional trade. The master's claim predicate is role === "merchant"
 * (see its eligibleForStall): merchants run the real stalls, claim the
 * pitch ring, publish day wares and run the Trade interface. The 2-layer
 * owns commoners only, so this exclusion runs BEFORE the share roll.
 * Never throws.
 */
function isProStallMerchant(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    return role === "merchant" || role === "MERCHANT";
  } catch {
    return false;
  }
}

/**
 * True when CitizenHawkers2 claims this citizen — called through the
 * hawkers' real claim function (hawkerTypeOf), i.e. its null path, so
 * basket-cryers with no stall are never also provisional stallfolk.
 * Never throws.
 */
function isHawkerfolk(record) {
  try {
    if (!Hawkers2 || typeof Hawkers2.hawkerTypeOf !== "function") return false;
    return Hawkers2.hawkerTypeOf(record) !== null;
  } catch {
    return false;
  }
}

/**
 * The stall type for a roster record, or null.
 * Excludes the professional stall merchants (role gate — the master's
 * claim) and the hawkerfolk (basket-cryers have no stalls). Both
 * exclusions run BEFORE the share roll, so they hold regardless of the
 * 35% draw. Uses name-first salts to avoid the FNV-1a prefix-correlation
 * bug.
 */
function stallTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    if (isProStallMerchant(record)) return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    if (isHawkerfolk(record)) return null;
    const roll = hashStr(name + "|marketstalls2") % 100;
    if (roll >= STALL_SHARE) return null;
    return stallTypeFromRoll(hashStr(name + "|marketstalls2-type") % 100);
  } catch {
    return null;
  }
}

/** The day's fringe stall pitch for a stallfolk citizen: kingdom-preferred. */
function stallPitchFor(record, dateMs = Date.now()) {
  try {
    const kid = record?.kingdomId ?? record?.kingdom;
    const name = normalizeName(record?.username) || "anon";
    const local = kid
      ? STALLS.filter((s) => String(s.kingdom).toLowerCase() === String(kid).toLowerCase())
      : [];
    const src = local.length ? local : STALLS;
    const day = dayNumber(dateMs);
    const rng = seededRng(hashStr(name + "|stallpitch:" + day));
    return pickOne(rng, src);
  } catch {
    return null;
  }
}

/** Today's provisional goods for a stallfolk citizen: seeded per day — the
 * same display all day. */
function goodsFor(username, type, dateMs = Date.now()) {
  try {
    const name = normalizeName(username) || "anon";
    const pool = GOODS[type] ?? GOODS[BARROW_FOLK];
    const day = dayNumber(dateMs);
    const rng = seededRng(hashStr(name + "|stallgoods:" + day));
    return pickOne(rng, pool);
  } catch {
    return null;
  }
}

/** Today's task for a stallfolk citizen (1 task of the day, for journals). */
function taskForToday(username, type, dateMs) {
  const name = normalizeName(username) || "anon";
  const lines = DAILY_TASK_LINES[type] ?? DAILY_TASK_LINES[BARROW_FOLK];
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|stalltask:" + day));
  return pickOne(rng, lines);
}

// ============================================================================
// Daily set-pieces (seeded per kingdom per day / per pitch per day).
// ============================================================================

/** Wheel-off: the kingdom's barrow-folk lose a wheel today (~6%). */
function wheelOffFor(kingdomId, dateMs) {
  if (!kingdomId) return false;
  const day = dayNumber(dateMs);
  return chance(seededRng(hashStr("stallwheel:" + kingdomId + ":" + day)), WHEEL_OFF_CHANCE);
}

/** Moved-along: the kingdom's guards clear the provisional pitches (~7%). */
function movedAlongFor(kingdomId, dateMs) {
  if (!kingdomId) return false;
  const day = dayNumber(dateMs);
  return chance(seededRng(hashStr("stallmoved:" + kingdomId + ":" + day)), MOVED_ALONG_CHANCE);
}

/** Haggle crowd: buyers gather round this pitch today (~8%/pitch/day). */
function stallCrowdFor(pitch, dateMs) {
  if (!pitch) return false;
  const day = dayNumber(dateMs);
  return chance(seededRng(hashStr("stallcrowd:" + pitch.name + ":" + day)), STALL_CROWD_CHANCE);
}

// ============================================================================
// Real-data bridge — the professional market wares, cross-read read-only.
// ============================================================================

/**
 * Read-only bridge: what the professional market stalls are selling in this
 * kingdom today, drawn from the master CitizenMarketStalls day-wares pools
 * (the master's own dailyWaresFor, seeded per kingdom per day), so
 * stallfolk small talk stays consistent with the actual market. Returns an
 * array of pretty ware names, or null. Never throws, never mutates master
 * state: the master module's attribute, inventory top-ups and stall-state
 * maps are never touched.
 */
function masterWaresFor(kingdomId, nowMs = Date.now()) {
  try {
    if (!ProMarket || typeof ProMarket.dailyWaresFor !== "function") return null;
    if (typeof ProMarket.dateKeyFor !== "function") return null;
    const kid = String(kingdomId ?? "");
    if (!kid) return null;
    const key = ProMarket.dateKeyFor(new Date(nowMs));
    const wares = ProMarket.dailyWaresFor("stallfolk2:" + kid, "prime", key);
    if (!Array.isArray(wares) || wares.length === 0) return null;
    return wares.map(prettyWare).filter(Boolean);
  } catch {
    return null;
  }
}

// ============================================================================
// Journal + rumor helpers (top-level requires; never throw).
// ============================================================================

function journalize(citizen, text) {
  try {
    if (Journal && typeof Journal.appendEntry === "function") {
      Journal.appendEntry(citizen, text);
    } else if (Journal && typeof Journal.addEntry === "function") {
      Journal.addEntry(citizen, text);
    }
  } catch { /* journal absent */ }
}

function seedRumor(rng, event) {
  try {
    if (Rumors && typeof Rumors.seedRumor === "function") Rumors.seedRumor(rng, event);
  } catch { /* rumors absent */ }
}

/** Scripted speech via forceChat; never throws. */
function forceSay(citizen, text) {
  try {
    citizen.forceChat?.(String(text).slice(0, 120));
  } catch { /* cosmetic */ }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → LOD brain gate → stallfolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickStallfolk(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < STALL_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible stall life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be stallfolk (hash-derived, cheap; exclusions inside)
        const type = stallTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 5. Work hours only (amateur market hours: 7 to 18)
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, STALL_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, STALL_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doStallWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-marketstalls2] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: wheel-offs and moved-alongs (cheap, day-gated).
    dailyRhythms(director, nowMs);
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-marketstalls2] tick failed:", e?.message ?? e);
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function doStallWork(director, record, citizen, type, nowMs) {
  const name = normalizeName(record.username);
  const kid = record?.kingdomId ?? record?.kingdom;
  const day = dayNumber(nowMs);
  const pitch = stallPitchFor(record, nowMs);
  const place = pitch ? pitch.name : "the market fringe";
  const goods = goodsFor(name, type, nowMs) ?? "wares";

  // Wheel-off set-piece: the kingdom's barrow-folk lose a wheel today.
  if (kid && type === BARROW_FOLK && wheelOffFor(kid, nowMs)) {
    forceSay(citizen, fill(pickOne(Math.random, WHEEL_OFF_LINES), {}));
    journalize(citizen, `lost a barrow wheel at ${place}`);
    return;
  }

  // Moved-along set-piece: the guards clear the provisional pitch.
  if (kid && movedAlongFor(kid, nowMs) && Math.random() < 0.5) {
    forceSay(citizen, fill(pickOne(Math.random, MOVED_ALONG_LINES), {}));
    journalize(citizen, `was moved along from ${place} by the guard`);
    seedRumor(Math.random, {
      kind: "stall",
      what: `the guard moved the stallfolk along at ${place} — no pitch stays there long`,
      who: record.username,
      where: place,
    });
    return;
  }

  // Haggle-crowd moment: once per pitch per day, buyers gather round.
  if (pitch && stallCrowdFor(pitch, nowMs)) {
    const key = "stallcrowd:" + pitch.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      forceSay(citizen, fill(pickOne(Math.random, CROWD_LINES), { goods, place }));
      journalize(citizen, `drew a haggle crowd with ${goods} at ${place}`);
      seedRumor(Math.random, {
        kind: "stall",
        what: `a haggle crowd gathered round a provisional stall at ${place}`,
        who: record.username,
        where: place,
      });
      return;
    }
  }

  const wares = kid ? masterWaresFor(kid, nowMs) : null;
  const roll = Math.random();
  if (roll < 0.6) {
    // Before 10:00: still setting up. After: the midday cries.
    const hour = new Date(nowMs).getHours();
    if (hour < SETUP_CUTOFF_HOUR) {
      forceSay(citizen, fill(pickOne(Math.random, SETUP_LINES), {}));
    } else {
      const lines = STALL_LINES[type] ?? STALL_LINES[BARROW_FOLK];
      forceSay(citizen, fill(pickOne(Math.random, lines), { goods }));
    }
    journalize(citizen, `${taskForToday(name, type, nowMs).replace("{place}", place)} — cried the pitch`);
  } else if (wares && wares.length) {
    const ware = pickOne(Math.random, wares);
    forceSay(citizen, fill(pickOne(Math.random, MARKET_TALK_LINES), { ware, goods }));
    journalize(citizen, `talked the real market wares while selling ${goods} at ${place}`);
  } else {
    const lines = STALL_LINES[type] ?? STALL_LINES[BARROW_FOLK];
    forceSay(citizen, fill(pickOne(Math.random, lines), { goods }));
    journalize(citizen, `cried ${goods} at ${place}`);
  }
}

/** Once-per-day kingdom rhythms: wheel-offs and moved-alongs. */
function dailyRhythms(director, nowMs) {
  const day = dayNumber(nowMs);
  try {
    const kingdoms = [...new Set(STALLS.map((s) => s.kingdom).filter(Boolean))];
    for (const kid of kingdoms) {
      if (wheelOffFor(kid, nowMs)) {
        const key = "daily-stallwheel:" + kid + ":" + day;
        if (!lastFiredByCitizen.has(key)) {
          lastFiredByCitizen.set(key, nowMs);
          const pitch = STALLS.find((s) => s.kingdom === kid);
          const line = `The barrow-folk in ${kid} lost a wheel — the barrows are down at ${pitch ? pitch.name : kid}.`;
          journalize({ username: "the stallfolk" }, line);
          seedRumor(Math.random, { kind: "stall", what: line, who: "the stallfolk", where: kid });
        }
      }
      if (movedAlongFor(kid, nowMs)) {
        const key = "daily-stallmoved:" + kid + ":" + day;
        if (!lastFiredByCitizen.has(key)) {
          lastFiredByCitizen.set(key, nowMs);
          const pitch = STALLS.find((s) => s.kingdom === kid);
          const line = `The guard moved the provisional stalls along in ${kid} — the fringe pitches at ${pitch ? pitch.name : kid} are cleared.`;
          journalize({ username: "the stallfolk" }, line);
          seedRumor(Math.random, { kind: "stall", what: line, who: "the stallfolk", where: kid });
        }
      }
    }
  } catch { /* daily rhythms are best-effort */ }
}

module.exports = {
  tickStallfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  stallTypeOf,
  isProStallMerchant,
  isHawkerfolk,
  stallPitchFor,
  goodsFor,
  taskForToday,
  wheelOffFor,
  movedAlongFor,
  stallCrowdFor,
  masterWaresFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  prettyWare,
  stallTypeFromRoll,
  isRealPlayer,
  withinTiles,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  STALL_TYPES,
  BARROW_FOLK,
  BLANKET_FOLK,
  CRATE_FOLK,
  SETUP_LINES,
  STALL_LINES,
  WHEEL_OFF_LINES,
  MOVED_ALONG_LINES,
  CROWD_LINES,
  MARKET_TALK_LINES,
  DAILY_TASK_LINES,
  STALLS,
  GOODS,
  // Tuning (tests pin the documented behavior):
  STALL_RADIUS,
  STALL_CITIZEN_COOLDOWN_MS,
  STALL_CHANCE,
  STALL_SHARE,
  WHEEL_OFF_CHANCE,
  MOVED_ALONG_CHANCE,
  STALL_CROWD_CHANCE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  SETUP_CUTOFF_HOUR,
  STALL_TYPES_WEIGHTS: STALL_WEIGHTS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    lastPruneAt = 0;
  },
  // Test seam (read/write view of the cooldown/crowd-once-per-day map):
  _lastFiredByCitizen: lastFiredByCitizen,
};
