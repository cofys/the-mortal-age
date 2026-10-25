"use strict";
const data = require("../data/duke-sucellus.json");
const BOSS_SIZE = 7;
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
function powderYield(level) {
  return clamp(Math.floor((level - 20) / 10), 1, 6);
}
function saltYield(level) {
  return level >= 80 ? 6 : level >= 75 ? 5 : level >= 70 ? 4 : 3;
}
function feed(meter, amount, maximum) {
  if (meter >= maximum)
    return { consumed: false, meter: maximum, awake: true };
  const next = Math.min(maximum, meter + amount);
  return { consumed: true, meter: next, awake: next >= maximum };
}
function gasCount(hitpoints) {
  return hitpoints <= data.normal.hitpoints / 2 ? 2 : 1;
}
function attackTicks(hitpoints) {
  return hitpoints <= data.normal.enrageHp ? data.normal.enrageTicks : data.normal.attackTicks;
}
class AttackClock {
  constructor() {
    this.autos = 0;
    this.gasAutos = 0;
    this.seenGaze = false;
    this.justGazed = false;
    this.gasInterval = 3;
  }
  next(hitpoints) {
    if (this.autos === 5) {
      this.autos = 0;
      this.seenGaze = true;
      this.justGazed = true;
      return "gaze";
    }
    if (this.seenGaze && this.gasAutos >= this.gasInterval && !this.justGazed) {
      this.gasAutos = 0;
      this.gasInterval = hitpoints > data.normal.hitpoints * 0.75 ? 5 :
        hitpoints > data.normal.enrageHp ? 4 : 3;
      return "gas";
    }
    this.autos++;
    if (this.seenGaze)
      this.gasAutos++;
    this.justGazed = false;
    return "auto";
  }
}
/** Segment/rectangle intersection for the source-room pillars. */
function rayCrossesBox(from, to, [x, y, width, height]) {
  let minimum = 0;
  let maximum = 1;
  for (const [axis, low, high] of [[0, x, x + width], [1, y, y + height]]) {
    const delta = to[axis] - from[axis];
    if (delta === 0) {
      if (from[axis] < low || from[axis] > high)
        return false;
      continue;
    }
    let entry = (low - from[axis]) / delta;
    let exit = (high - from[axis]) / delta;
    if (entry > exit)
      [entry, exit] = [exit, entry];
    minimum = Math.max(minimum, entry);
    maximum = Math.min(maximum, exit);
    if (minimum > maximum)
      return false;
  }
  return maximum > 0 && minimum < 1;
}
function hidden([x, y]) {
  const [bossX, bossY] = data.site.boss;
  const centre = [bossX + BOSS_SIZE / 2, bossY + BOSS_SIZE / 2];
  return data.pillars.some(pillar => rayCrossesBox(centre, [x + 0.5, y + 0.5], pillar));
}
function melee([x, y]) {
  const [bossX, bossY] = data.site.boss;
  return x >= bossX - 1 && x <= bossX + BOSS_SIZE &&
    y >= bossY - 1 && y <= bossY + BOSS_SIZE;
}
function near([x, y], [targetX, targetY], distance = 1) {
  return Math.abs(x - targetX) <= distance && Math.abs(y - targetY) <= distance;
}
function extremityHit(eye, [x, y]) {
  // The rotated 3x2 wall object leaves a one-tile cone tip immediately in
  // front, then three and five tiles on successive outward rows (DT2 Wiki).
  const depth = eye.face === 3 ? x - eye.tile[0] - 2 : eye.tile[0] - 1 - x;
  return depth >= 0 && depth <= 2 && Math.abs(y - (eye.tile[1] + 1)) <= depth;
}
module.exports = { powderYield, saltYield, feed, gasCount, attackTicks, AttackClock, hidden, melee, near, extremityHit };
