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
// Append-only event log. New events are appended here (fast, O(new data))
// instead of rewriting the full snapshot every save. The snapshot is only
// rewritten on compaction (when the log grows large) or clean shutdown.
const LOG_FILE = path.join(process.cwd(), "data", "saves", "citizen-journal.log");
// Compact (rewrite snapshot + truncate log) when the log exceeds this size.
const LOG_COMPACT_BYTES = 10 * 1024 * 1024;

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
    this._logPath = LOG_FILE;
    this._pending = []; // [{ key, event } | { key, forget: true }] since last save
  }

  /** Test seam. */
  resetForTests() {
    this.entries = new Map();
    this.dirty = false;
    this._savePath = null;
    this._logPath = null;
    this._pending = [];
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
    // Queue for the append-only log (written on save, not on every event).
    this._pending.push({ key: normalizeName(citizenName), event });
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
    if (this.entries.delete(key)) {
      this.dirty = true;
      // Tombstone in the log so replay drops the record too.
      this._pending.push({ key, forget: true });
    }
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
      // No snapshot yet; start empty and replay the log if it exists.
      parsed = null;
    }
    try {
      this.entries = new Map();
      for (const [key, record] of Object.entries(parsed?.citizens ?? {})) {
        this.entries.set(key, {
          display: record?.display ?? key,
          events: Array.isArray(record?.events) ? record.events : [],
        });
      }
      // Replay the append-only log (events since the last snapshot).
      this._replayLog();
      this.prune(Date.now());
      this.dirty = false;
      this._pending = [];
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Replay the append-only log onto the in-memory state.
   * Each line is { key, event } or { key, forget: true }.
   * Corrupt lines are skipped (crash safety: partial writes don't poison the log).
   */
  _replayLog() {
    if (!this._logPath) return;
    let content = null;
    try {
      content = fs.readFileSync(this._logPath, "utf8");
    } catch {
      return; // No log file yet.
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry = null;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue; // Skip corrupt lines (torn writes).
      }
      if (!entry || typeof entry.key !== "string") continue;
      if (entry.forget) {
        this.entries.delete(entry.key);
        continue;
      }
      if (!entry.event || typeof entry.event !== "object") continue;
      const record = this._record(entry.key);
      // Preserve display name from the event if the record is new.
      record.events.push(entry.event);
      while (record.events.length > MAX_EVENTS_PER_CITIZEN) record.events.shift();
    }
  }

  /**
   * Append pending events to the log file (fast, O(new events)).
   * Only rewrites the full snapshot when the log grows past LOG_COMPACT_BYTES.
   * Crash-safe: appends are atomic; on crash, replay recovers everything written.
   */
  saveIfDirty() {
    if (!this.dirty || !this._logPath) return false;
    try {
      this.prune(Date.now());
      fs.mkdirSync(path.dirname(this._logPath), { recursive: true });
      // Append pending events as NDJSON (one JSON object per line).
      if (this._pending.length > 0) {
        const lines = this._pending.map((p) => JSON.stringify(p)).join("\n") + "\n";
        fs.appendFileSync(this._logPath, lines, "utf8");
        this._pending = [];
      }
      this.dirty = false;
      // Compact if the log is getting large (rewrite snapshot, truncate log).
      // This is the only full rewrite, and it's infrequent.
      try {
        const stat = fs.statSync(this._logPath);
        if (stat.size > LOG_COMPACT_BYTES) this.compact();
      } catch {
        // Log may not exist yet; ignore.
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Rewrite the full snapshot and truncate the log.
   * Called automatically when the log grows large, or on clean shutdown.
   * Crash-safe: writes snapshot to temp file, atomic rename, then truncates log.
   */
  compact() {
    if (!this._savePath || !this._logPath) return false;
    try {
      this.prune(Date.now());
      fs.mkdirSync(path.dirname(this._savePath), { recursive: true });
      const tmpPath = this._savePath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(this.toJSON()));
      fs.renameSync(tmpPath, this._savePath);
      // Truncate the log (all events are now in the snapshot).
      fs.writeFileSync(this._logPath, "", "utf8");
      this._pending = [];
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Force a full snapshot write (for clean shutdown).
   * Ensures no data lives only in the log.
   */
  saveSnapshot() {
    return this.compact();
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
