"use strict";

/**
 * CitizenJournal — what each citizen has been UP TO.
 *
 * Jon's key insight: "They don't need to literally be talking if no one is
 * near, but the data needs to say they were."
 *
 * Two-tier simulation:
 *   BACKGROUND (cheap, data-only): when no player is near, citizens live as
 *   data. This journal records what happened — who they talked to, what they
 *   sold, what they heard, where they went. Zero LLM calls. Just structured
 *   events appended on the director tick.
 *   FOREGROUND (LLM, expensive): when a player IS near and interacting, the
 *   LLM reads the journal and roleplays truthfully from it. "What have you
 *   been up to?" gets a real answer because the data says what happened.
 *
 * The handoff is seamless: a citizen's words are always consistent with
 * their journal, because the journal is the source of truth the prompt reads.
 *
 * Event: { at, kind, text, with, data }
 *   kind: met | chatted | traded | worked | earned | heard | argued |
 *         befriended | traveled | ate | rested | goal | social | mood
 * Bounded: MAX_EVENTS per citizen (rolling). Persisted alongside
 * citizen-memory.json. Plain-node testable.
 */

const fs = require("fs");
const path = require("path");

const SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-journal.json");

const MAX_EVENTS_PER_CITIZEN = 30;
// Journal entries older than this are pruned (they're stale news).
const EVENT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function normalizeName(name) {
  return String(name ?? "").toLowerCase().trim();
}

function blankEvent(kind, text, opts = {}) {
  return {
    at: opts.at ?? Date.now(),
    kind,
    text: String(text ?? "").slice(0, 200),
    with: opts.with ? String(opts.with).slice(0, 64) : null,
    data: opts.data ?? null,
  };
}

class CitizenJournal {
  constructor() {
    this.entries = new Map(); // citizenKey -> { display, events: [...] }
    this.dirty = false;
    this._savePath = SAVE_FILE;
  }

  /** Test seam. */
  resetForTests() {
    this.entries = new Map();
    this.dirty = false;
    this._savePath = null;
  }

  _record(citizenName) {
    const key = normalizeName(citizenName);
    let record = this.entries.get(key);
    if (!record) {
      record = { display: String(citizenName ?? key), events: [] };
      this.entries.set(key, record);
    }
    return record;
  }

  /**
   * Log something that happened to/involving this citizen. Cheap — no LLM.
   * Call from the background tick, brain actions, trade handlers, etc.
   */
  log(citizenName, kind, text, opts = {}) {
    if (!citizenName || !kind || !text) return null;
    const record = this._record(citizenName);
    const event = blankEvent(kind, text, opts);
    record.events.push(event);
    while (record.events.length > MAX_EVENTS_PER_CITIZEN) record.events.shift();
    this.dirty = true;
    return event;
  }

  /** Last N events, newest first. What the foreground prompt reads. */
  recent(citizenName, count = 5) {
    const record = this.entries.get(normalizeName(citizenName));
    if (!record) return [];
    return record.events.slice(-count).reverse();
  }

  /** One-line "lately" summary for the LLM prompt. */
  latelyLine(citizenName, count = 3) {
    const events = this.recent(citizenName, count);
    if (events.length === 0) return "";
    return events.map((e) => e.text).join(" ");
  }

  /** Did these two citizens interact recently? (for relationship flavor) */
  interactedRecently(citizenA, citizenB, withinMs = 24 * 3600 * 1000) {
    const now = Date.now();
    const record = this.entries.get(normalizeName(citizenA));
    if (!record) return false;
    const bKey = normalizeName(citizenB);
    return record.events.some(
      (e) => e.with && normalizeName(e.with) === bKey && now - e.at < withinMs
    );
  }

  prune(now = Date.now()) {
    for (const record of this.entries.values()) {
      record.events = record.events.filter((e) => now - e.at < EVENT_MAX_AGE_MS);
      while (record.events.length > MAX_EVENTS_PER_CITIZEN) record.events.shift();
    }
  }

  /**
   * Drop all journal data for a citizen who no longer exists (refugee
   * column stood down, war casualty). Prevents orphaned records from
   * accumulating across wars. Memory-leak plug, 2026-10-07.
   */
  forget(citizenName) {
    const key = normalizeName(citizenName);
    if (this.entries.delete(key)) this.dirty = true;
  }

  toJSON() {
    const citizens = {};
    for (const [key, record] of this.entries) {
      citizens[key] = { display: record.display, events: record.events };
    }
    return { version: 1, citizens };
  }

  load() {
    if (!this._savePath) return false;
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this._savePath, "utf8"));
    } catch {
      return false;
    }
    try {
      this.entries = new Map();
      for (const [key, record] of Object.entries(parsed?.citizens ?? {})) {
        this.entries.set(key, {
          display: record?.display ?? key,
          events: Array.isArray(record?.events) ? record.events : [],
        });
      }
      this.prune(Date.now());
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }

  saveIfDirty() {
    if (!this.dirty || !this._savePath) return false;
    try {
      this.prune(Date.now());
      fs.mkdirSync(path.dirname(this._savePath), { recursive: true });
      fs.writeFileSync(this._savePath, JSON.stringify(this.toJSON()));
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }
}

let singleton = null;

function getJournal() {
  if (!singleton) singleton = new CitizenJournal();
  return singleton;
}

function initCitizenJournal() {
  const journal = getJournal();
  journal.load();
  return journal;
}

module.exports = {
  CitizenJournal,
  getJournal,
  initCitizenJournal,
  MAX_EVENTS_PER_CITIZEN,
};
