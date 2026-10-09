"use strict";

/**
 * CitizenGalleries — the data tier for gallery operations.
 *
 * Complements (does not duplicate) CitizenArt:
 *   - CitizenArt owns: art mediums, artwork creation, gallery DISPLAY spaces,
 *     the fixed-price art market, and exhibitions.
 *   - This owns: the curator profession registry, competitive AUCTIONS
 *     (bidding, not fixed-price), gallery ACQUISITIONS (permanent collections
 *     bought with real acquisition budgets), COMMISSIONS (patron escrow for
 *     bespoke works), APPRAISALS (curator valuations for a fee), TRAVELING
 *     exhibitions (curated shows touring kingdoms), and gallery PRESTIGE.
 *
 * What it does (data tier, free — read by the slow tick and the brain):
 *   - Curators: persistent registry of citizens employed to run galleries.
 *   - Auctions: artworks consigned for competitive bidding. Bids are real
 *     coin commitments (held in escrow from the bidder's inventory). Highest
 *     bid at close wins; losers are refunded. Reserve prices are honest —
 *     below reserve = no sale.
 *   - Acquisitions: galleries accrue real acquisition budgets (from
 *     admissions + a kingdom stipend). Curators spend budgets on artworks
 *     for the permanent collection. Collection pieces raise gallery
 *     prestige.
 *   - Commissions: patrons post commissions (medium + theme + escrowed
 *     coins). Artists accept, create, deliver. Escrow releases on delivery.
 *   - Appraisals: curators appraise artworks for a flat fee, using
 *     CitizenArt.valueFor (read-only — this never reimplements valuation).
 *   - Traveling exhibitions: curated sets of collection pieces that tour
 *     other kingdoms over real travel time, raising prestige on arrival.
 *   - Prestige: per-kingdom gallery prestige 0-100 from collections,
 *     exhibitions hosted, and auction volume. Read by culture systems.
 *
 * What it does NOT do:
 *   - No ticking here. Auction closes, budget accrual, exhibition travel,
 *     and announcements live in lib/CitizenGalleriesLife.js.
 *   - No LLM. Auction lot names and exhibition titles come from template
 *     frames filled with real data (artist, medium, kingdom).
 *   - No invented items or coins: every bid, fee, and payout moves real
 *     coins through real inventories (or honest bank credits for offline
 *     citizens). No invented geography: gallery tiles come from
 *     CitizenArt.galleryFor (display space) — this never invents tiles.
 *   - Never touches lib/*2 (frozen).
 *
 * Persisted to data/saves/citizen-galleries.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-galleries.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- tuning ------------------------------------------------------------------

const COIN_ID = 995;
const APPRAISAL_FEE = 25; // flat fee per appraisal, real coins
const AUCTION_LISTING_FEE = 10; // flat fee to consign, real coins
const AUCTION_DURATION_MS = 3 * 24 * 60 * 60 * 1000; // 3-day auctions
const AUCTION_HOUSE_CUT_BPS = 500; // 5% house cut on hammer price
const ACQUISITION_STIPEND_WEEKLY = 200; // kingdom stipend per week, real coins
const ADMISSION_SHARE_BPS = 2000; // 20% of special-exhibition admissions → budget
const PRESTIGE_MAX = 100;
const TRAVEL_DAYS_PER_KINGDOM = 2; // real-time travel between kingdoms

// --- state -------------------------------------------------------------------

function blankState() {
  return {
    curators: {}, // normName -> { username, kingdomId, appointedAt, appraisals, auctionsRun }
    galleries: {}, // kingdomId -> { prestige, budget, collection: [artworkIds], acquisitions, lastStipendAt }
    auctions: [], // { id, artworkId, seller, kingdomId, startAt, endsAt, reserve, bids: [{bidder, amount, at}], status, winner, hammerPrice }
    commissions: [], // { id, patron, medium, theme, escrow, kingdomId, status, artist, createdAt, deliveredAt }
    appraisals: [], // { id, artworkId, curator, fee, value, at }
    tours: [], // { id, name, kingdomIds, pieces: [artworkIds], currentIdx, departsAt, arrivesAt, status }
    seq: 0,
  };
}

let _state = null;
let _dirty = false;
let _savePath = null;

function load() {
  if (_state && _savePath === SAVE_FILE) return _state;
  _savePath = SAVE_FILE;
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    _state = Object.assign(blankState(), parsed);
  } catch {
    _state = blankState();
  }
  _dirty = false;
  return _state;
}

function markDirty() {
  _dirty = true;
}

function save() {
  if (!_dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(_state, null, 2));
    _dirty = false;
    return true;
  } catch {
    return false;
  }
}

function resetForTests() {
  _state = blankState();
  _savePath = SAVE_FILE;
  _dirty = false;
  try {
    fs.unlinkSync(SAVE_FILE);
  } catch {
    // no save file — fine
  }
}

function nextId(prefix, nowMs) {
  const st = load();
  st.seq += 1;
  markDirty();
  return `${prefix}-${nowMs.toString(36)}-${st.seq}`;
}

// --- coin helpers (real inventories only) ------------------------------------

function countCoins(player) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return 0;
    if (typeof inv.count === "function") return inv.count(COIN_ID);
    if (typeof inv.getAmount === "function") return inv.getAmount(COIN_ID);
    return 0;
  } catch {
    return 0;
  }
}

function removeCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return 0;
    const have = countCoins(player);
    const take = Math.min(have, amount);
    if (take <= 0) return 0;
    if (typeof inv.remove === "function") inv.remove(COIN_ID, take);
    else if (typeof inv.delete === "function") inv.delete(COIN_ID, take);
    else return 0;
    return take;
  } catch {
    return 0;
  }
}

function giveCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv || amount <= 0) return 0;
    if (typeof inv.add === "function") inv.add(COIN_ID, amount);
    else return 0;
    return amount;
  } catch {
    return 0;
  }
}

/** Credit coins to an offline citizen via their bank account (honest). */
function creditBank(username, amount) {
  try {
    const Banking = require("./CitizenBanking");
    const acct = Banking.accountFor(username);
    if (!acct) return false;
    acct.balance = (acct.balance ?? 0) + amount;
    if (typeof Banking.markDirty === "function") Banking.markDirty();
    else if (typeof Banking.save === "function") Banking.save();
    return true;
  } catch {
    return false;
  }
}

// --- curators ----------------------------------------------------------------

/**
 * Register a citizen as a gallery curator. Idempotent.
 * Only citizens (or the appoint flow) call this — players use ::gallery.
 */
function registerCurator(username, kingdomId, nowMs = Date.now()) {
  const st = load();
  const key = normalizeName(username);
  if (!key) return null;
  if (st.curators[key]) return st.curators[key];
  st.curators[key] = {
    username: key,
    kingdomId: String(kingdomId ?? "unknown"),
    appointedAt: nowMs,
    appraisals: 0,
    auctionsRun: 0,
    commissionsBrokered: 0,
  };
  markDirty();
  return st.curators[key];
}

function isCurator(username) {
  const st = load();
  return !!st.curators[normalizeName(username)];
}

function curatorInfo(username) {
  const st = load();
  return st.curators[normalizeName(username)] ?? null;
}

function curatorsIn(kingdomId) {
  const st = load();
  const key = String(kingdomId ?? "unknown");
  return Object.values(st.curators).filter((c) => c.kingdomId === key);
}

// --- gallery operations ------------------------------------------------------

function galleryOpsFor(kingdomId, nowMs = Date.now()) {
  const st = load();
  const key = String(kingdomId ?? "unknown");
  if (!st.galleries[key]) {
    st.galleries[key] = {
      kingdomId: key,
      prestige: 10, // every gallery starts with modest standing
      budget: 0, // acquisition budget, real coins tracked
      collection: [], // permanent collection artwork ids
      acquisitions: 0,
      exhibitionsHosted: 0,
      auctionVolume: 0,
      lastStipendAt: 0, // 0 = never paid; first tick pays the stipend
    };
    markDirty();
  }
  return st.galleries[key];
}

/** Prestige 0-100 for a kingdom's gallery. Defensive read for culture. */
function prestigeFor(kingdomId) {
  try {
    const st = load();
    const key = String(kingdomId ?? "unknown");
    const g = st.galleries[key];
    if (!g) return 10;
    return Math.max(0, Math.min(PRESTIGE_MAX, g.prestige ?? 10));
  } catch {
    return 10;
  }
}

function addPrestige(kingdomId, delta) {
  const g = galleryOpsFor(kingdomId);
  g.prestige = Math.max(0, Math.min(PRESTIGE_MAX, (g.prestige ?? 10) + delta));
  markDirty();
  return g.prestige;
}

/** Gallery tile — read from CitizenArt's display gallery (never invented). */
function galleryTile(kingdomId) {
  try {
    const Art = require("./CitizenArt");
    const gallery = Art.galleryFor(kingdomId);
    // CitizenArt galleries are deterministic near the market; if it exposes
    // a tile use it, otherwise derive from the market tile via CitizenSites.
    if (gallery?.tile) return gallery.tile;
    const { siteTile } = require("../brain/CitizenSites");
    return siteTile("market", kingdomId) ?? null;
  } catch {
    return null;
  }
}

// --- auctions ----------------------------------------------------------------

/**
 * Consign an artwork to auction. The artwork must exist in CitizenArt and be
 * owned by the seller. Listing fee is real coins from the seller's inventory.
 * Returns { ok, auction?, reason? }.
 */
function consignAuction(artworkId, sellerPlayer, reserve, nowMs = Date.now()) {
  const st = load();
  let Art;
  try {
    Art = require("./CitizenArt");
  } catch {
    return { ok: false, reason: "art-unavailable" };
  }
  const seller = normalizeName(usernameOf(sellerPlayer));
  if (!seller) return { ok: false, reason: "no-seller" };

  // Find the artwork in CitizenArt's store via its public surface.
  const owned = Art.artworksOf(seller).find((a) => a.id === artworkId);
  if (!owned) return { ok: false, reason: "not-owned" };
  if (owned.forSale) return { ok: false, reason: "already-listed" };
  if (st.auctions.some((a) => a.artworkId === artworkId && a.status === "open")) {
    return { ok: false, reason: "already-auctioned" };
  }

  // Listing fee — honest failure when broke.
  if (countCoins(sellerPlayer) < AUCTION_LISTING_FEE) {
    return { ok: false, reason: "insufficient-coins" };
  }
  const taken = removeCoins(sellerPlayer, AUCTION_LISTING_FEE);
  if (taken < AUCTION_LISTING_FEE) return { ok: false, reason: "no-remove" };

  const auction = {
    id: nextId("auc", nowMs),
    artworkId,
    title: owned.title ?? "Untitled",
    medium: owned.medium ?? "painting",
    artist: owned.artist ?? seller,
    seller,
    kingdomId: String(owned.kingdomId ?? "unknown"),
    startAt: nowMs,
    endsAt: nowMs + AUCTION_DURATION_MS,
    reserve: Math.max(0, reserve | 0),
    bids: [],
    status: "open",
    winner: null,
    hammerPrice: 0,
  };
  st.auctions.push(auction);
  markDirty();

  // Count the auction toward a curator's record if one runs this kingdom.
  const curs = curatorsIn(auction.kingdomId);
  if (curs[0]) {
    curs[0].auctionsRun += 1;
    markDirty();
  }
  return { ok: true, auction };
}

/**
 * Place a bid. The bid amount is ESCROWED from the bidder's real inventory
 * immediately (honest commitment). A new high bid refunds the previous
 * high bidder. Returns { ok, reason?, outbid? }.
 */
function placeBid(auctionId, bidderPlayer, amount, payBidder, nowMs = Date.now()) {
  const st = load();
  const auction = st.auctions.find((a) => a.id === auctionId);
  if (!auction) return { ok: false, reason: "not-found" };
  if (auction.status !== "open") return { ok: false, reason: "closed" };
  if (nowMs >= auction.endsAt) return { ok: false, reason: "ended" };
  const bidder = normalizeName(usernameOf(bidderPlayer));
  if (!bidder) return { ok: false, reason: "no-bidder" };
  if (bidder === auction.seller) return { ok: false, reason: "own-auction" };
  amount = amount | 0;
  if (amount <= 0) return { ok: false, reason: "bad-amount" };

  const high = auction.bids.length ? auction.bids[auction.bids.length - 1].amount : 0;
  const minBid = high > 0 ? high + 1 : Math.max(1, auction.reserve);
  if (amount < minBid) return { ok: false, reason: "too-low", minBid };

  // Escrow the bid — honest failure when broke.
  if (countCoins(bidderPlayer) < amount) return { ok: false, reason: "insufficient-coins" };
  const taken = removeCoins(bidderPlayer, amount);
  if (taken < amount) return { ok: false, reason: "no-remove" };

  // Refund the previous high bidder.
  let outbid = null;
  const prev = auction.bids[auction.bids.length - 1];
  if (prev) {
    outbid = prev.bidder;
    const refunded = payBidder ? payBidder(prev.bidder, prev.amount) : false;
    if (!refunded) creditBank(prev.bidder, prev.amount);
  }

  auction.bids.push({ bidder, amount, at: nowMs });
  markDirty();
  return { ok: true, outbid };
}

/**
 * Close an auction (called by the slow tick when endsAt passes).
 * Winner pays hammer price minus escrowed bid; house takes its cut;
 * seller gets the rest. Below reserve = no sale, high bidder refunded.
 * payee: (username, amount) => boolean — pays online players; falls back
 * to bank credit for offline citizens.
 */
function closeAuction(auctionId, payee, nowMs = Date.now()) {
  const st = load();
  const auction = st.auctions.find((a) => a.id === auctionId);
  if (!auction) return { ok: false, reason: "not-found" };
  if (auction.status !== "open") return { ok: false, reason: "already-closed" };

  const high = auction.bids.length ? auction.bids[auction.bids.length - 1] : null;
  if (!high || high.amount < auction.reserve) {
    // No sale — refund the high bidder if any.
    if (high) {
      const refunded = payee ? payee(high.bidder, high.amount) : false;
      if (!refunded) creditBank(high.bidder, high.amount);
    }
    auction.status = "unsold";
    auction.winner = null;
    markDirty();
    return { ok: true, sold: false };
  }

  const hammer = high.amount;
  const cut = Math.floor((hammer * AUCTION_HOUSE_CUT_BPS) / 10000);
  const sellerProceeds = hammer - cut;

  // Winner's escrow already taken at bid time — nothing more to take.
  // Pay the seller.
  const paid = payee ? payee(auction.seller, sellerProceeds) : false;
  if (!paid) creditBank(auction.seller, sellerProceeds);

  // House cut → gallery acquisition budget (real tracked coins).
  const ops = galleryOpsFor(auction.kingdomId, nowMs);
  ops.budget += cut;
  ops.auctionVolume += hammer;
  markDirty();

  // Transfer ownership in CitizenArt (defensive — the record lives there).
  try {
    const Art = require("./CitizenArt");
    if (typeof Art.transferOwnership === "function") {
      Art.transferOwnership(auction.artworkId, high.bidder);
    }
  } catch {
    // artwork record unreachable — sale still settled in coins
  }

  auction.status = "sold";
  auction.winner = high.bidder;
  auction.hammerPrice = hammer;
  addPrestige(auction.kingdomId, 2);
  markDirty();
  return { ok: true, sold: true, winner: high.bidder, hammerPrice: hammer, houseCut: cut };
}

/** Open auctions in a kingdom, ending soonest first. */
function openAuctions(kingdomId) {
  const st = load();
  const key = String(kingdomId ?? "unknown");
  return st.auctions
    .filter((a) => a.status === "open" && a.kingdomId === key)
    .sort((a, b) => a.endsAt - b.endsAt);
}

/** Auctions whose end time has passed but are still open (for the tick). */
function ripeAuctions(nowMs = Date.now()) {
  const st = load();
  return st.auctions.filter((a) => a.status === "open" && a.endsAt <= nowMs);
}

// --- acquisitions ------------------------------------------------------------

/**
 * A curator spends the gallery's acquisition budget on an artwork for the
 * permanent collection. The artwork must be listed for sale in CitizenArt's
 * market (or bought directly from its owner at an agreed price).
 * Returns { ok, reason? }.
 */
function acquireForCollection(artworkId, curatorUsername, price, paySeller, nowMs = Date.now()) {
  const st = load();
  const curator = curatorInfo(curatorUsername);
  if (!curator) return { ok: false, reason: "not-curator" };
  const ops = galleryOpsFor(curator.kingdomId, nowMs);
  price = price | 0;
  if (price <= 0) return { ok: false, reason: "bad-price" };
  if (ops.budget < price) return { ok: false, reason: "insufficient-budget" };

  let Art;
  try {
    Art = require("./CitizenArt");
  } catch {
    return { ok: false, reason: "art-unavailable" };
  }
  // The piece must exist and not already be in a collection.
  const alreadyHeld = Object.values(st.galleries).some((g) =>
    (g.collection ?? []).includes(artworkId)
  );
  if (alreadyHeld) return { ok: false, reason: "already-collected" };

  // Pay the current owner (look up across all artists is expensive; use the
  // artwork record if the module exposes a lookup, else fail honestly).
  let owner = null;
  try {
    if (typeof Art.artworkById === "function") {
      const rec = Art.artworkById(artworkId);
      owner = rec ? normalizeName(rec.owner) : null;
    }
  } catch {
    owner = null;
  }
  if (!owner) return { ok: false, reason: "not-found" };

  ops.budget -= price;
  ops.collection.push(artworkId);
  ops.acquisitions += 1;
  const paid = paySeller ? paySeller(owner, price) : false;
  if (!paid) creditBank(owner, price);
  try {
    if (typeof Art.transferOwnership === "function") {
      Art.transferOwnership(artworkId, `gallery:${ops.kingdomId}`);
    }
  } catch {
    // record unreachable — coins still moved
  }
  addPrestige(ops.kingdomId, 3);
  markDirty();
  return { ok: true, owner, price };
}

/** Accrue the weekly kingdom stipend into the acquisition budget. */
function accrueStipend(kingdomId, nowMs = Date.now()) {
  const ops = galleryOpsFor(kingdomId, nowMs);
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  if (nowMs - (ops.lastStipendAt ?? 0) < WEEK) return 0;
  ops.budget += ACQUISITION_STIPEND_WEEKLY;
  ops.lastStipendAt = nowMs;
  markDirty();
  return ACQUISITION_STIPEND_WEEKLY;
}

// --- commissions -------------------------------------------------------------

/**
 * A patron posts a commission: medium + theme + escrowed coins.
 * Escrow is taken from the patron's real inventory immediately.
 */
function postCommission(patronPlayer, medium, theme, escrowAmount, kingdomId, nowMs = Date.now()) {
  const st = load();
  const patron = normalizeName(usernameOf(patronPlayer));
  if (!patron) return { ok: false, reason: "no-patron" };
  escrowAmount = escrowAmount | 0;
  if (escrowAmount <= 0) return { ok: false, reason: "bad-escrow" };
  const VALID_MEDIUMS = ["painting", "sculpture", "writing"];
  if (!VALID_MEDIUMS.includes(String(medium))) return { ok: false, reason: "bad-medium" };

  if (countCoins(patronPlayer) < escrowAmount) return { ok: false, reason: "insufficient-coins" };
  const taken = removeCoins(patronPlayer, escrowAmount);
  if (taken < escrowAmount) return { ok: false, reason: "no-remove" };

  const commission = {
    id: nextId("com", nowMs),
    patron,
    medium: String(medium),
    theme: String(theme ?? "untitled").slice(0, 60),
    escrow: escrowAmount,
    kingdomId: String(kingdomId ?? "unknown"),
    status: "open", // open → accepted → delivered | cancelled
    artist: null,
    createdAt: nowMs,
    deliveredAt: 0,
    artworkId: null,
  };
  st.commissions.push(commission);
  markDirty();
  return { ok: true, commission };
}

/** An artist accepts an open commission. */
function acceptCommission(commissionId, artistUsername, nowMs = Date.now()) {
  const st = load();
  const c = st.commissions.find((x) => x.id === commissionId);
  if (!c) return { ok: false, reason: "not-found" };
  if (c.status !== "open") return { ok: false, reason: "not-open" };
  const artist = normalizeName(artistUsername);
  if (!artist) return { ok: false, reason: "no-artist" };
  if (artist === c.patron) return { ok: false, reason: "own-commission" };
  c.status = "accepted";
  c.artist = artist;
  c.acceptedAt = nowMs;
  markDirty();
  return { ok: true, commission: c };
}

/**
 * Deliver a commissioned artwork. The artwork must exist in CitizenArt and
 * be owned by the artist. Escrow releases to the artist (real coins).
 */
function deliverCommission(commissionId, artworkId, payee, nowMs = Date.now()) {
  const st = load();
  const c = st.commissions.find((x) => x.id === commissionId);
  if (!c) return { ok: false, reason: "not-found" };
  if (c.status !== "accepted") return { ok: false, reason: "not-accepted" };

  let Art;
  try {
    Art = require("./CitizenArt");
  } catch {
    return { ok: false, reason: "art-unavailable" };
  }
  const owned = Art.artworksOf(c.artist).find((a) => a.id === artworkId);
  if (!owned) return { ok: false, reason: "not-owned" };
  if (owned.medium !== c.medium) return { ok: false, reason: "wrong-medium" };

  const paid = payee ? payee(c.artist, c.escrow) : false;
  if (!paid) creditBank(c.artist, c.escrow);
  try {
    if (typeof Art.transferOwnership === "function") {
      Art.transferOwnership(artworkId, c.patron);
    }
  } catch {
    // record unreachable — escrow still released
  }
  c.status = "delivered";
  c.deliveredAt = nowMs;
  c.artworkId = artworkId;
  addPrestige(c.kingdomId, 1);
  markDirty();

  // Broker credit for the kingdom's curator.
  const curs = curatorsIn(c.kingdomId);
  if (curs[0]) {
    curs[0].commissionsBrokered += 1;
    markDirty();
  }
  return { ok: true, escrow: c.escrow };
}

/** Cancel an open commission — escrow returns to the patron. */
function cancelCommission(commissionId, payee) {
  const st = load();
  const c = st.commissions.find((x) => x.id === commissionId);
  if (!c) return { ok: false, reason: "not-found" };
  if (c.status !== "open") return { ok: false, reason: "not-open" };
  const refunded = payee ? payee(c.patron, c.escrow) : false;
  if (!refunded) creditBank(c.patron, c.escrow);
  c.status = "cancelled";
  markDirty();
  return { ok: true, refunded: c.escrow };
}

function openCommissions(kingdomId) {
  const st = load();
  const key = String(kingdomId ?? "unknown");
  return st.commissions.filter((c) => c.status === "open" && c.kingdomId === key);
}

// --- appraisals --------------------------------------------------------------

/**
 * A curator appraises an artwork for a flat fee. Valuation is read from
 * CitizenArt.valueFor — this module never reimplements it.
 */
function appraise(artworkId, curatorUsername, clientPlayer, nowMs = Date.now()) {
  const st = load();
  const curator = curatorInfo(curatorUsername);
  if (!curator) return { ok: false, reason: "not-curator" };
  const client = normalizeName(usernameOf(clientPlayer));
  if (!client) return { ok: false, reason: "no-client" };

  let Art;
  try {
    Art = require("./CitizenArt");
  } catch {
    return { ok: false, reason: "art-unavailable" };
  }
  let rec = null;
  try {
    rec = typeof Art.artworkById === "function" ? Art.artworkById(artworkId) : null;
  } catch {
    rec = null;
  }
  if (!rec) {
    // Fall back: search the client's own works.
    rec = Art.artworksOf(client).find((a) => a.id === artworkId) ?? null;
  }
  if (!rec) return { ok: false, reason: "not-found" };

  if (countCoins(clientPlayer) < APPRAISAL_FEE) return { ok: false, reason: "insufficient-coins" };
  const taken = removeCoins(clientPlayer, APPRAISAL_FEE);
  if (taken < APPRAISAL_FEE) return { ok: false, reason: "no-remove" };

  const value = Art.valueFor(rec);
  const record = {
    id: nextId("apr", nowMs),
    artworkId,
    curator: curator.username,
    client,
    fee: APPRAISAL_FEE,
    value,
    at: nowMs,
  };
  st.appraisals.push(record);
  curator.appraisals += 1;

  // Fee → gallery budget (the house takes appraisal fees).
  const ops = galleryOpsFor(curator.kingdomId, nowMs);
  ops.budget += APPRAISAL_FEE;
  markDirty();
  return { ok: true, appraisal: record };
}

// --- traveling exhibitions ---------------------------------------------------

const TOUR_NAME_FRAMES = Object.freeze([
  "{kingdom} Masters on Tour",
  "Treasures of {kingdom}",
  "The {kingdom} Collection Abroad",
]);

/**
 * Send a traveling exhibition: up to 6 collection pieces tour other
 * kingdoms. Travel takes real time (TRAVEL_DAYS_PER_KINGDOM per hop).
 * Deterministic name from real data — never invented prose.
 */
function sendTour(curatorUsername, kingdomIds, nowMs = Date.now()) {
  const st = load();
  const curator = curatorInfo(curatorUsername);
  if (!curator) return { ok: false, reason: "not-curator" };
  const ops = galleryOpsFor(curator.kingdomId, nowMs);
  const pieces = (ops.collection ?? []).slice(0, 6);
  if (pieces.length === 0) return { ok: false, reason: "empty-collection" };
  const targets = (kingdomIds ?? []).map(String).filter((k) => k !== ops.kingdomId);
  if (targets.length === 0) return { ok: false, reason: "no-destinations" };
  if (st.tours.some((t) => t.status !== "done" && t.homeKingdom === ops.kingdomId)) {
    return { ok: false, reason: "already-touring" };
  }

  const frame = TOUR_NAME_FRAMES[pieces.length % TOUR_NAME_FRAMES.length];
  const tour = {
    id: nextId("tour", nowMs),
    name: frame.replace("{kingdom}", ops.kingdomId),
    homeKingdom: ops.kingdomId,
    kingdomIds: targets,
    pieces,
    currentIdx: -1, // -1 = en route to first stop
    departsAt: nowMs,
    arrivesAt: nowMs + TRAVEL_DAYS_PER_KINGDOM * 24 * 60 * 60 * 1000,
    status: "traveling",
  };
  st.tours.push(tour);
  markDirty();
  return { ok: true, tour };
}

/** Advance tours whose arrival time has passed (called by the slow tick). */
function advanceTours(nowMs = Date.now()) {
  const st = load();
  const arrived = [];
  for (const tour of st.tours) {
    if (tour.status === "traveling" && tour.arrivesAt <= nowMs) {
      tour.currentIdx += 1;
      if (tour.currentIdx >= tour.kingdomIds.length) {
        tour.status = "done";
        // Homecoming boosts prestige back home.
        addPrestige(tour.homeKingdom, 4);
      } else {
        const stopKingdom = tour.kingdomIds[tour.currentIdx];
        addPrestige(stopKingdom, 2);
        addPrestige(tour.homeKingdom, 1);
        tour.status = "showing";
        tour.showingUntil = nowMs + 3 * 24 * 60 * 60 * 1000; // 3-day show
      }
      arrived.push(tour);
      markDirty();
    } else if (tour.status === "showing" && (tour.showingUntil ?? 0) <= nowMs) {
      // Move on to the next stop.
      tour.status = "traveling";
      tour.arrivesAt = nowMs + TRAVEL_DAYS_PER_KINGDOM * 24 * 60 * 60 * 1000;
      markDirty();
    }
  }
  return arrived;
}

// --- misc --------------------------------------------------------------------

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? player?.username ?? "";
  } catch {
    return "";
  }
}

function stats(kingdomId) {
  const st = load();
  const key = String(kingdomId ?? "unknown");
  const ops = st.galleries[key];
  return {
    curators: curatorsIn(key).length,
    prestige: prestigeFor(key),
    budget: ops?.budget ?? 0,
    collectionSize: ops?.collection?.length ?? 0,
    openAuctions: openAuctions(key).length,
    openCommissions: openCommissions(key).length,
    activeTours: st.tours.filter((t) => t.status !== "done" && t.homeKingdom === key).length,
  };
}

/**
 * Fame deeds earned by a curator. Public API for the reputation system.
 * grandcurator: ran five auctions. artbroker: brokered five commissions.
 */
function deedsForCurator(username) {
  const st = load();
  const key = normalizeName(username);
  const out = [];
  const curator = st.curators[key];
  if (!curator) return out;
  if ((curator.auctionsRun ?? 0) >= 5) out.push("grandcurator");
  if ((curator.commissionsBrokered ?? 0) >= 5) out.push("artbroker");
  return out;
}

module.exports = {
  _setSavePathForTests,
  resetForTests,
  save,
  markDirty,
  // curators
  registerCurator,
  isCurator,
  curatorInfo,
  curatorsIn,
  // gallery ops
  galleryOpsFor,
  prestigeFor,
  addPrestige,
  galleryTile,
  stats,
  // auctions
  consignAuction,
  placeBid,
  closeAuction,
  openAuctions,
  ripeAuctions,
  // acquisitions
  acquireForCollection,
  accrueStipend,
  // commissions
  postCommission,
  acceptCommission,
  deliverCommission,
  cancelCommission,
  openCommissions,
  // appraisals
  appraise,
  // tours
  sendTour,
  advanceTours,
  // fame deeds
  deedsForCurator,
  // tuning (read-only for tests)
  AUCTION_LISTING_FEE,
  APPRAISAL_FEE,
  AUCTION_HOUSE_CUT_BPS,
};
