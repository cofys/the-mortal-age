"use strict";

/**
 * CitizenArrival — brain-side arrival behavior (whereabouts slice 2,
 * Jon 2026-10-13).
 *
 * Slice 1 moved offline citizens to want-driven destinations; settle() in
 * lib/CitizenWhereaboutsLife stamps record.arrived with the place kind.
 * When the citizen materializes, they should behave like a player who just
 * walked somewhere: arrive at a gather place -> start gathering; arrive at
 * a square/market -> idle-social; arrive at a bank -> sort the bank. The
 * human player model (session arc: arrive -> check stuff -> main activity
 * -> wind down -> leave) calls this the "main activity" seed — it replaces
 * a blank re-pick on the first decision.
 *
 * Needs utility still wins: a hurt or weary citizen gets nothing seeded —
 * the needs/interrupt engine (hurt/exhausted -> rest/meal) owns them.
 *
 * The marker is consumed once (the caller clears it) so a re-materialize
 * doesn't re-seed, and it's only honored while fresh and while the citizen
 * is still near the arrival tile — a traveler who passed through a square
 * three hours ago doesn't suddenly start socializing there.
 *
 * Pure data plumbing on record.arrived (written from record.dest at settle
 * time): no new coordinates, no hash fiction, no new *2/*3 modules.
 */

const {
  ACT_CHOP,
  ACT_MINE,
  ACT_FISH,
  ACT_SOCIAL,
  ACT_BANK,
} = require("./CitizenDecisions");
const { needsFor, HURT_AT, WEARY_AT } = require("./CitizenNeeds");

// An arrival only explains the spawn moment: older than this, the citizen
// has been standing around and the normal picker owns them.
const ARRIVAL_FRESH_MS = 10 * 60 * 1000;
// Settle jitter is 2..8 tiles; this covers engine drift at spawn.
const ARRIVAL_NEAR_TILES = 10;

// "home" deliberately maps to nothing: citizens sent home hurt or weary
// belong to the needs engine (rest), and healthy ones get a normal pick.
const ACTIVITY_BY_KIND = {
  tree: ACT_CHOP,
  rock: ACT_MINE,
  fish: ACT_FISH,
  square: ACT_SOCIAL,
  market: ACT_SOCIAL,
  bank: ACT_BANK,
};

function cheby(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/**
 * The activity to seed for a citizen who just arrived, or null when the
 * normal decision path should own them. Never throws.
 */
function arrivalActivityFor(record, nowMs) {
  try {
    const now = nowMs ?? Date.now();
    const arrival = record?.arrived;
    if (!arrival || typeof arrival.kind !== "string") return null;
    const activityId = ACTIVITY_BY_KIND[arrival.kind];
    if (!activityId) return null;
    if (
      Number.isFinite(arrival.at) &&
      now - arrival.at > ARRIVAL_FRESH_MS
    ) {
      return null; // stale — they've been standing around
    }
    const p = record?.position;
    if (
      !p ||
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      !Number.isFinite(arrival.x) ||
      !Number.isFinite(arrival.y)
    ) {
      return null;
    }
    if ((p.z ?? 0) !== (arrival.z ?? 0)) return null;
    if (cheby(p.x, p.y, arrival.x, arrival.y) > ARRIVAL_NEAR_TILES) {
      return null; // passed through, not still there
    }
    // Needs utility wins: hurt or weary citizens belong to the
    // needs/interrupt engine (rest/meal), not the arrival seed.
    const needs = needsFor(record.username);
    if (needs && (needs.hp < HURT_AT || needs.energy < WEARY_AT)) {
      return null;
    }
    return activityId;
  } catch {
    return null;
  }
}

module.exports = {
  arrivalActivityFor,
  ARRIVAL_FRESH_MS,
  ARRIVAL_NEAR_TILES,
  ACTIVITY_BY_KIND,
};
