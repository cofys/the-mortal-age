"use strict";

/**
 * house-value — pure logic for player housing valuation.
 *
 * A house's value is computed from REAL engine data (see ./construction-data.js,
 * generated from ConstructionData.ts):
 *   - every room contributes its real build cost in coins
 *   - every furniture piece contributes buildable XP x 10 (XP is the engine's
 *     own quality proxy: oak/teak/mahogany/marble/gold furniture costs more
 *     and grants more XP than crude pine)
 *
 * Value tiers drive citizen visitor commentary and the housing overlay:
 *   hovel < 25k < cottage < 100k < house < 500k < manor < 2M < palace
 *
 * No engine access here — pass the house save (`construction:house`
 * attribute) in, get numbers out. Fully testable in plain node.
 */

const { BUILDABLE_XP, ROOM_DATA } = require("./construction-data");

const FURNITURE_XP_MULTIPLIER = 10;

const TIERS = Object.freeze([
  { key: "hovel", name: "Hovel", min: 0 },
  { key: "cottage", name: "Cottage", min: 25000 },
  { key: "house", name: "House", min: 100000 },
  { key: "manor", name: "Manor", min: 500000 },
  { key: "palace", name: "Palace", min: 2000000 },
]);

/** All rooms in a PlayerHouseSave: rooms[plane][x][y]. */
function eachRoom(save) {
  const out = [];
  const planes = save?.rooms;
  if (!Array.isArray(planes)) return out;
  for (const plane of planes) {
    if (!Array.isArray(plane)) continue;
    for (const row of plane) {
      if (!Array.isArray(row)) continue;
      for (const room of row) {
        if (room && typeof room.roomKey === "string") out.push(room);
      }
    }
  }
  return out;
}

/** All furniture buildable keys in a room (both hotspot map shapes). */
function furnitureKeys(room) {
  const keys = [];
  const flat = room?.furniture;
  if (flat && typeof flat === "object") {
    for (const k of Object.values(flat)) {
      if (typeof k === "string") keys.push(k);
      else if (k && typeof k.buildableKey === "string") keys.push(k.buildableKey);
    }
  }
  const byLoc = room?.furnitureByLocation;
  if (byLoc && typeof byLoc === "object") {
    for (const f of Object.values(byLoc)) {
      if (typeof f === "string") keys.push(f);
      else if (f && typeof f.buildableKey === "string") keys.push(f.buildableKey);
    }
  }
  return keys;
}

function roomValue(roomKey) {
  const data = ROOM_DATA[roomKey];
  return data ? Number(data.cost) || 0 : 0;
}

function furnitureValue(buildableKey) {
  const xp = BUILDABLE_XP[buildableKey];
  return (Number(xp) || 0) * FURNITURE_XP_MULTIPLIER;
}

/**
 * Full valuation of a house save.
 * Returns { value, tier, rooms: [{key,name,cost,furniture}], furnitureCount }.
 */
function valueHouse(save) {
  const rooms = [];
  let value = 0;
  let furnitureCount = 0;
  for (const room of eachRoom(save)) {
    const data = ROOM_DATA[room.roomKey];
    const cost = roomValue(room.roomKey);
    let furnValue = 0;
    const keys = furnitureKeys(room);
    for (const k of keys) furnValue += furnitureValue(k);
    furnitureCount += keys.length;
    value += cost + furnValue;
    rooms.push({
      key: room.roomKey,
      name: data ? data.name : room.roomKey,
      level: data ? data.level : 0,
      cost,
      furnitureCount: keys.length,
      furnitureValue: furnValue,
    });
  }
  return { value, tier: tierFor(value), rooms, furnitureCount, roomCount: rooms.length };
}

function tierFor(value) {
  let tier = TIERS[0];
  for (const t of TIERS) {
    if (value >= t.min) tier = t;
  }
  return tier;
}

/** Does the house save contain a room with this key? */
function hasRoom(save, roomKey) {
  return eachRoom(save).some((r) => r.roomKey === roomKey);
}

/** Highest-value room key in the save (for "showpiece" commentary). */
function showpieceRoom(save) {
  let best = null;
  let bestValue = -1;
  for (const room of eachRoom(save)) {
    const v = roomValue(room.roomKey);
    if (v > bestValue) {
      bestValue = v;
      best = room.roomKey;
    }
  }
  return best;
}

module.exports = {
  valueHouse,
  tierFor,
  hasRoom,
  showpieceRoom,
  eachRoom,
  furnitureKeys,
  roomValue,
  furnitureValue,
  TIERS,
  FURNITURE_XP_MULTIPLIER,
};
