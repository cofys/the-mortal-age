"use strict";

/**
 * CitizenObservatories.test.js — plain-node tests (no jest).
 * Run: node server/plugins/citizens/lib/CitizenObservatories.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const Obs = require("./CitizenObservatories");

const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "obs-test-")), "citizen-observatories.json");
Obs._setSavePathForTests(tmpSave);

// --- stub the astronomy profession layer -------------------------------------
const astroPath = path.join(__dirname, "CitizenAstronomy.js");
const astroSrc = fs.readFileSync(astroPath, "utf8");
require.cache[astroPath] = {
  exports: {
    observatoryFor: (kid) => (kid === "misthalin" ? { kingdomId: kid, tile: { x: 100, y: 200 } } : null),
    astronomerFor: (u) => (u === "Stargazer_Sue" ? { username: u, kingdomId: "misthalin" } : null),
    chartsFor: (kid) =>
      kid === "misthalin"
        ? [
            { id: "chart_1", astronomer: "Stargazer_Sue", kingdomId: kid, quality: 8 },
            { id: "chart_2", astronomer: "Stargazer_Sue", kingdomId: kid, quality: 3 },
          ]
        : [],
    activeEventFor: (kid, nowMs) => (kid === "misthalin" && nowMs % 2 === 0 ? { kind: "comet" } : null),
  },
};

function reset() {
  Obs.resetForTests();
}

function makePlayer(username, coins) {
  const items = coins > 0 ? [{ id: 995, quantity: coins }] : [];
  return {
    username,
    getUsername: () => username,
    getInventory: () => ({
      getItems: () => items,
      removeItem: (id, qty) => {
        const it = items.find((i) => i.id === id);
        if (!it || it.quantity < qty) return false;
        it.quantity -= qty;
        return true;
      },
    }),
  };
}

const NIGHT = new Date(2026, 5, 15, 23, 0, 0).getTime(); // 11pm June
const DAY = new Date(2026, 5, 15, 12, 0, 0).getTime(); // noon June

let passed = 0;
function test(name, fn) {
  reset();
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

// --- sky ---
test("isNight: night vs day", () => {
  assert.strictEqual(Obs.isNight(NIGHT), true);
  assert.strictEqual(Obs.isNight(DAY), false);
});

test("whatIsVisible: deterministic objects, no randomness", () => {
  const a = Obs.whatIsVisible("misthalin", NIGHT);
  const b = Obs.whatIsVisible("misthalin", NIGHT);
  assert.deepStrictEqual(a.objects, b.objects);
  assert.ok(a.objects.length >= 2, "should see planets/zodiac/moon");
});

test("whatIsVisible: includes active event when present", () => {
  // NIGHT is even ms? force via stub: use an even timestamp
  const evenNight = NIGHT % 2 === 0 ? NIGHT : NIGHT + 1;
  const v = Obs.whatIsVisible("misthalin", evenNight);
  assert.strictEqual(v.event, "comet");
});

test("describeSky: template frame from real data", () => {
  const s = Obs.describeSky("misthalin", NIGHT);
  assert.ok(typeof s === "string" && s.length > 0);
});

// --- visits ---
test("beginVisit: honest closed-daytime", () => {
  const p = makePlayer("Visitor_Vic", 100);
  const r = Obs.beginVisit(p, "misthalin", DAY);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "closed-daytime");
});

test("beginVisit: honest cannot-afford", () => {
  const p = makePlayer("Broke_Bob", 5);
  const r = Obs.beginVisit(p, "misthalin", NIGHT);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "cannot-afford");
});

test("beginVisit: honest no-observatory for unknown kingdom", () => {
  const p = makePlayer("Visitor_Vic", 100);
  const r = Obs.beginVisit(p, "asgarnia", NIGHT);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no-observatory");
});

test("beginVisit: success takes real coins, funds observatory", () => {
  const p = makePlayer("Visitor_Vic", 100);
  const r = Obs.beginVisit(p, "misthalin", NIGHT);
  assert.strictEqual(r.ok, true);
  assert.ok(r.visitId);
  assert.strictEqual(Obs.fundFor("misthalin"), Obs.ENTRY_FEE);
  assert.ok(Obs.endVisit(r.visitId, NIGHT + 1000));
});

test("recordSighting: stores what was seen", () => {
  const p = makePlayer("Visitor_Vic", 100);
  const v = Obs.recordSighting(p, "misthalin", NIGHT);
  assert.ok(v && v.objects.length > 0);
  const s = Obs.sightingFor(p);
  assert.deepStrictEqual(s.objects, v.objects);
});

// --- chart shop ---
test("chartsForSale: real charts with honest prices", () => {
  const forSale = Obs.chartsForSale("misthalin");
  assert.strictEqual(forSale.length, 2);
  assert.strictEqual(forSale[0].price, Obs.CHART_BASE_PRICE + 8 * Obs.CHART_PRICE_PER_QUALITY);
});

test("chartsForSale: empty when no charts", () => {
  assert.deepStrictEqual(Obs.chartsForSale("asgarnia"), []);
});

test("buyChart: honest no-such-chart", () => {
  const p = makePlayer("Buyer_Bea", 1000);
  const r = Obs.buyChart(p, "chart_nope", "misthalin", NIGHT);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no-such-chart");
});

test("buyChart: honest cannot-afford", () => {
  const p = makePlayer("Broke_Bob", 10);
  const r = Obs.buyChart(p, "chart_1", "misthalin", NIGHT);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "cannot-afford");
});

test("buyChart: success moves real coins, records copy", () => {
  const p = makePlayer("Buyer_Bea", 1000);
  const before = Obs.fundFor("misthalin");
  const r = Obs.buyChart(p, "chart_1", "misthalin", NIGHT);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(Obs.fundFor("misthalin"), before + r.chart.price);
  const copies = Obs.chartCopiesFor(p);
  assert.strictEqual(copies.length, 1);
  assert.strictEqual(copies[0].id, "chart_1");
  assert.strictEqual(copies[0].quality, 8);
  // idempotent — buying again does not duplicate
  const p2 = makePlayer("Buyer_Bea", 1000);
  Obs.buyChart(p2, "chart_1", "misthalin", NIGHT);
  assert.strictEqual(Obs.chartCopiesFor(p2).length, 1);
});

// --- tours ---
test("scheduleTour: only real astronomers may lead", () => {
  const r = Obs.scheduleTour("Not_An_Astronomer", "misthalin", NIGHT);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-an-astronomer");
});

test("scheduleTour: success with 1h notice", () => {
  const r = Obs.scheduleTour("Stargazer_Sue", "misthalin", NIGHT);
  assert.strictEqual(r.ok, true);
  const tours = Obs.toursFor("misthalin", NIGHT);
  assert.strictEqual(tours.length, 1);
  assert.strictEqual(tours[0].scheduledFor, NIGHT + 60 * 60 * 1000);
});

test("joinTour: honest tour-full", () => {
  const r = Obs.scheduleTour("Stargazer_Sue", "misthalin", NIGHT);
  const tourId = r.tourId;
  for (let i = 0; i < Obs.MAX_TOUR_ATTENDEES; i++) {
    Obs.joinTour(makePlayer(`P${i}`, 0), tourId, NIGHT);
  }
  const full = Obs.joinTour(makePlayer("Late_Larry", 0), tourId, NIGHT);
  assert.strictEqual(full.ok, false);
  assert.strictEqual(full.reason, "tour-full");
});

test("joinTour: honest tour-over", () => {
  const r = Obs.scheduleTour("Stargazer_Sue", "misthalin", NIGHT);
  const late = Obs.joinTour(makePlayer("Late_Larry", 0), r.tourId, NIGHT + 10 * 3600 * 1000);
  assert.strictEqual(late.ok, false);
  assert.strictEqual(late.reason, "tour-over");
});

// --- parties ---
test("maybeStartParty: starts when event active", () => {
  const evenNight = NIGHT % 2 === 0 ? NIGHT : NIGHT + 1;
  const party = Obs.maybeStartParty("misthalin", evenNight);
  assert.ok(party);
  assert.strictEqual(party.eventKind, "comet");
  // idempotent while live
  const again = Obs.maybeStartParty("misthalin", evenNight + 1000);
  assert.strictEqual(again.startedAt, party.startedAt);
});

test("maybeStartParty: null when no event", () => {
  const oddNight = NIGHT % 2 === 1 ? NIGHT : NIGHT + 1;
  assert.strictEqual(Obs.maybeStartParty("asgarnia", oddNight), null);
});

test("joinParty: honest no-party", () => {
  const r = Obs.joinParty(makePlayer("Party_Pam", 0), "asgarnia", NIGHT);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no-party");
});

test("joinParty: success records attendee", () => {
  const evenNight = NIGHT % 2 === 0 ? NIGHT : NIGHT + 1;
  Obs.maybeStartParty("misthalin", evenNight);
  const r = Obs.joinParty(makePlayer("Party_Pam", 0), "misthalin", evenNight);
  assert.strictEqual(r.ok, true);
  assert.ok(r.party.attendees.includes("Party_Pam"));
});

// --- gatherings ---
test("hostGathering: honest closed-daytime", () => {
  const r = Obs.hostGathering(makePlayer("Host_Hank", 0), "misthalin", DAY);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "closed-daytime");
});

test("hostGathering + joinGathering: player-hosted stargazing", () => {
  const h = Obs.hostGathering(makePlayer("Host_Hank", 0), "misthalin", NIGHT);
  assert.strictEqual(h.ok, true);
  const j = Obs.joinGathering(makePlayer("Guest_Gail", 0), h.gatheringId);
  assert.strictEqual(j.ok, true);
  assert.ok(j.gathering.attendees.includes("Guest_Gail"));
});

// --- describe ---
test("describe: null when no observatory", () => {
  assert.strictEqual(Obs.describe("asgarnia", NIGHT), null);
});

test("describe: real status frame", () => {
  const d = Obs.describe("misthalin", NIGHT);
  assert.ok(d);
  assert.strictEqual(d.open, true);
  assert.strictEqual(d.entryFee, Obs.ENTRY_FEE);
  assert.ok(typeof d.sky === "string");
});

// --- persistence ---
test("save/load round-trip", () => {
  const p = makePlayer("Visitor_Vic", 100);
  Obs.beginVisit(p, "misthalin", NIGHT);
  assert.strictEqual(Obs.save(), true);
  const raw = JSON.parse(fs.readFileSync(tmpSave, "utf8"));
  assert.ok(Object.keys(raw.visits).length >= 1);
});

console.log(`CitizenObservatories: ${passed} passed`);
if (process.exitCode) console.log("FAILURES PRESENT");
