// JsonMemoryStore -- conversation memory that survives restarts.
//
// The research found the quietest quota leak: the in-memory store loses every
// card/note/history on restart, so the FIRST contact after every deploy burns
// the flagship tier again (deploys are frequent during active development).
// This store keeps the exact MemoryStore interface but persists to JSON:
//
//   <cwd>/data/saves/llm-gateway-memory.json (env LLM_GATEWAY_MEMORY_FILE)
//
// Writes are dirty-flag + debounced (default 5s, env
// LLM_GATEWAY_MEMORY_FLUSH_MS) — never on the hot path, per the performance
// research on sync JSON writes. Writes go tmp+rename so a crash mid-write
// can't corrupt the file. flush() is also called on gateway shutdown.
//
// Bounds: MAX_HISTORY_PER_PLAYER (6) and MAX_NOTES_PER_PLAYER (20) per pair
// come from MemoryStore.js; MAX_PAIRS (default 2000) caps distinct
// citizen|player pairs — when exceeded, pairs whose newest exchange is
// oldest are evicted. Cards are tiny and re-registered on spawn anyway, so
// they're persisted too but unbounded by the pair cap only in the sense
// that citizens are few (~hundreds).

const fs = require("fs");
const path = require("path");
const { MemoryStore, MAX_HISTORY_PER_PLAYER } = require("./MemoryStore");

const DEFAULT_SAVE_NAME = "llm-gateway-memory.json";
const DEFAULT_FLUSH_MS = 5000;
const DEFAULT_MAX_PAIRS = 2000;
const MAX_NOTES_PER_PLAYER = 20;

const normalize = (name) => String(name ?? "").toLowerCase().trim();

function defaultSavePath() {
  return path.join(process.cwd(), "data", "saves", DEFAULT_SAVE_NAME);
}

function resolveMemoryPath() {
  if (process.env.LLM_GATEWAY_MEMORY_FILE !== undefined) {
    return process.env.LLM_GATEWAY_MEMORY_FILE || null; // empty = in-memory only
  }
  return defaultSavePath();
}

function pairKey(agentId, playerName) {
  return `${normalize(agentId)}|${normalize(playerName)}`;
}

class JsonMemoryStore extends MemoryStore {
  constructor(filePath, { flushMs, maxPairs } = {}) {
    super();
    this.filePath = filePath === undefined ? resolveMemoryPath() : filePath;
    this.flushMs =
      Number.isFinite(flushMs) ? Math.max(0, flushMs)
      : Number.isFinite(Number(process.env.LLM_GATEWAY_MEMORY_FLUSH_MS))
        ? Math.max(0, Number(process.env.LLM_GATEWAY_MEMORY_FLUSH_MS))
        : DEFAULT_FLUSH_MS;
    this.maxPairs = Number.isFinite(maxPairs) ? Math.max(1, maxPairs) : DEFAULT_MAX_PAIRS;
    this.cards = new Map();
    this.notes = new Map();
    this.history = new Map();
    this.dirty = false;
    this.flushTimer = null;
    if (this.filePath) this.load();
  }

  // --- persistence ---

  toJSON() {
    return {
      version: 1,
      savedAt: Date.now(),
      cards: Object.fromEntries(this.cards),
      notes: Object.fromEntries(this.notes),
      history: Object.fromEntries(this.history),
    };
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object") return;
      for (const [k, v] of Object.entries(parsed.cards ?? {})) {
        if (typeof v === "string") this.cards.set(k, v.slice(0, 2000));
      }
      for (const [k, v] of Object.entries(parsed.notes ?? {})) {
        if (Array.isArray(v)) this.notes.set(k, v.map(String).slice(0, MAX_NOTES_PER_PLAYER));
      }
      for (const [k, v] of Object.entries(parsed.history ?? {})) {
        if (Array.isArray(v)) this.history.set(k, v.slice(-MAX_HISTORY_PER_PLAYER));
      }
    } catch (error) {
      console.warn(`[llm-gateway] memory load failed (starting fresh): ${error?.message ?? error}`);
    }
  }

  markDirty() {
    this.dirty = true;
    if (!this.filePath || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushMs);
    if (typeof this.flushTimer.unref === "function") this.flushTimer.unref();
  }

  flush() {
    if (!this.filePath || !this.dirty) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2));
      fs.renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch (error) {
      console.warn(`[llm-gateway] memory save failed: ${error?.message ?? error}`);
    }
  }

  /** Called on gateway shutdown so nothing is lost mid-debounce. */
  shutdown() {
    this.flush();
  }

  evictPairsIfNeeded() {
    const over = this.history.size + this.notes.size - this.maxPairs * 2;
    if (over <= 0) return;
    // Evict pairs whose newest activity is oldest (history + notes share keys).
    const newest = new Map();
    for (const [k, list] of this.history) {
      const last = list[list.length - 1];
      newest.set(k, Math.max(newest.get(k) ?? 0, last?.at ?? 0));
    }
    for (const k of this.notes.keys()) {
      if (!newest.has(k)) newest.set(k, 0);
    }
    const ordered = [...newest.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < over && i < ordered.length; i++) {
      this.history.delete(ordered[i][0]);
      this.notes.delete(ordered[i][0]);
    }
  }

  // --- MemoryStore interface ---

  async getCard(agentId) {
    return this.cards.get(normalize(agentId)) ?? null;
  }

  async setCard(agentId, card) {
    const key = normalize(agentId);
    if (!key) return;
    this.cards.set(key, String(card ?? "").slice(0, 2000));
    this.markDirty();
  }

  async deleteCard(agentId) {
    const key = normalize(agentId);
    this.cards.delete(key);
    for (const map of [this.notes, this.history]) {
      for (const k of map.keys()) {
        if (k === key || k.startsWith(`${key}|`)) map.delete(k);
      }
    }
    this.markDirty();
  }

  async getNotes(agentId, playerName) {
    return [...(this.notes.get(pairKey(agentId, playerName)) ?? [])];
  }

  async addNote(agentId, playerName, note) {
    const key = pairKey(agentId, playerName);
    const list = this.notes.get(key) ?? [];
    const trimmed = String(note ?? "").trim().slice(0, 160);
    if (!trimmed || list.includes(trimmed)) return list;
    list.push(trimmed);
    while (list.length > MAX_NOTES_PER_PLAYER) list.shift();
    this.notes.set(key, list);
    this.evictPairsIfNeeded();
    this.markDirty();
    return list;
  }

  async getHistory(agentId, playerName, limit = MAX_HISTORY_PER_PLAYER) {
    const list = this.history.get(pairKey(agentId, playerName)) ?? [];
    return list.slice(-limit);
  }

  async pushExchange(agentId, playerName, playerText, replyText) {
    const key = pairKey(agentId, playerName);
    const list = this.history.get(key) ?? [];
    list.push({
      playerText: String(playerText ?? "").slice(0, 320),
      replyText: String(replyText ?? "").slice(0, 320),
      at: Date.now(),
    });
    while (list.length > MAX_HISTORY_PER_PLAYER) list.shift();
    this.history.set(key, list);
    this.evictPairsIfNeeded();
    this.markDirty();
  }
}

module.exports = { JsonMemoryStore, resolveMemoryPath, DEFAULT_MAX_PAIRS };
