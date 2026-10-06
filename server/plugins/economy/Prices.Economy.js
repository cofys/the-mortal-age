"use strict";

/**
 * Prices.Economy — the economy:price reference-price service.
 *
 * A reference price is the number citizen merchants, war boards, and
 * quartermasters use when they need a sane price *right now* without running
 * an auction. Baseline comes from the GE price data
 * (data/definitions/item-prices.json — the same table the GE plugin quotes),
 * adjusted by live demand pressure recorded from economy:demand broadcasts
 * and economy:item-sink volume. Pressure decays back to baseline; the
 * multiplier never exceeds PRICE_TUNING.maxMultiplier.
 *
 * Pure module: no api reference. Events.Economy.js owns the api and decides
 * whether a pressure update crossed the broadcast threshold (the record*
 * functions return a broadcast payload or null).
 */

const path = require("path");
const { PRICE_TUNING } = require("./constants");

let baselineTable = null; // lazy: { [itemId]: { high, low } }

/** Load the GE price table once; plain JSON, no core TS import (AGENTS.md). */
function loadBaseline() {
  if (baselineTable) return baselineTable;
  try {
    const file = path.join(__dirname, "..", "..", "data", "definitions", "item-prices.json");
    const raw = require(file);
    baselineTable = (raw && raw.data) || {};
  } catch {
    baselineTable = {};
  }
  return baselineTable;
}

/** Baseline reference value for an item id (GE high, else low, else 1). */
function getBaseline(itemId) {
  const entry = loadBaseline()[String(itemId)];
  if (!entry) return 1;
  return Math.max(1, Math.floor(entry.high || entry.low || 1));
}

/** itemId -> { multiplier, lastBroadcastMultiplier, updatedAt } */
const pressure = new Map();

function pressureFor(itemId, now) {
  let p = pressure.get(itemId);
  if (!p) {
    p = { multiplier: 1, lastBroadcastMultiplier: 1, updatedAt: now };
    pressure.set(itemId, p);
    return p;
  }
  // Decay toward 1.0 with the configured half-life.
  const elapsed = Math.max(0, now - p.updatedAt);
  if (elapsed > 0 && p.multiplier !== 1) {
    const halfLives = elapsed / PRICE_TUNING.pressureHalfLifeMs;
    p.multiplier = 1 + (p.multiplier - 1) * Math.pow(0.5, halfLives);
    if (Math.abs(p.multiplier - 1) < 0.001) p.multiplier = 1;
    p.updatedAt = now;
  }
  return p;
}

function addPressure(itemId, step, reason, now) {
  const p = pressureFor(itemId, now);
  p.multiplier = Math.min(PRICE_TUNING.maxMultiplier, p.multiplier + step);
  p.updatedAt = now;
  const moved = Math.abs(p.multiplier - p.lastBroadcastMultiplier);
  // Epsilon: exactly-at-threshold (e.g. 5 × 0.02) must fire deterministically,
  // not depend on which side of 0.1 the floats land on.
  if (moved + 1e-9 < PRICE_TUNING.broadcastThreshold) return null;
  const previous = Math.floor(getBaseline(itemId) * p.lastBroadcastMultiplier);
  const price = getReferencePrice(itemId, now);
  p.lastBroadcastMultiplier = p.multiplier;
  return { itemId, price, previous, reason };
}

/** Record a demand broadcast's pressure. Returns a broadcast payload or null. */
function recordDemand(itemId, now = Date.now()) {
  return addPressure(itemId, PRICE_TUNING.demandPressureStep, "demand", now);
}

/** Record a sink event's scarcity pressure. Returns a broadcast payload or null. */
function recordSink(itemId, now = Date.now()) {
  return addPressure(itemId, PRICE_TUNING.sinkPressureStep, "sink", now);
}

/** Current reference price: baseline × live multiplier, decayed to now. */
function getReferencePrice(itemId, now = Date.now()) {
  return Math.max(1, Math.floor(getBaseline(itemId) * pressureFor(itemId, now).multiplier));
}

/** Debug/read helper: how many items carry live (non-baseline) pressure. */
function pressuredCount(now = Date.now()) {
  let n = 0;
  for (const [itemId] of pressure) {
    if (pressureFor(itemId, now).multiplier !== 1) n++;
  }
  return n;
}

module.exports = {
  getBaseline,
  getReferencePrice,
  recordDemand,
  recordSink,
  pressuredCount,
  _pressure: pressure, // test seam
};
