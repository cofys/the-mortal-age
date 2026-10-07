// MemoryStore -- what each citizen knows about the players who talk to them.
//
// Interface (v1):
//   getCard(agentId) / setCard(agentId, card)          -- short personality card
//   getNotes(agentId, playerName) / addNote(agentId, playerName, note)
//       e.g. "Dave PKed me once, wary"
//   getHistory(agentId, playerName, limit)             -- last N exchanges
//   pushExchange(agentId, playerName, playerText, replyText)
//
// InMemoryMemoryStore is the v1 implementation (process-local, no disk).
// SqliteMemoryStore is STUBBED: the game host has no sqlite driver installed,
// so it no-ops with a clear marker. When a driver lands, the SQLite path keeps
// the same interface and persists cards/notes/history across restarts.

const MAX_NOTES_PER_PLAYER = 20;
const MAX_HISTORY_PER_PLAYER = 6;

class MemoryStore {
  async getCard(_agentId) { throw new Error("not implemented"); }
  async setCard(_agentId, _card) { throw new Error("not implemented"); }
  async deleteCard(_agentId) { throw new Error("not implemented"); }
  async getNotes(_agentId, _playerName) { throw new Error("not implemented"); }
  async addNote(_agentId, _playerName, _note) { throw new Error("not implemented"); }
  async getHistory(_agentId, _playerName, _limit = MAX_HISTORY_PER_PLAYER) { throw new Error("not implemented"); }
  async pushExchange(_agentId, _playerName, _playerText, _replyText) { throw new Error("not implemented"); }
}

const normalize = (name) => String(name ?? "").toLowerCase().trim();

class InMemoryMemoryStore extends MemoryStore {
  constructor() {
    super();
    this.cards = new Map(); // agentId -> card string
    this.notes = new Map(); // `${agentId}|${player}` -> [note]
    this.history = new Map(); // `${agentId}|${player}` -> [{playerText, replyText, at}]
  }

  async getCard(agentId) {
    return this.cards.get(normalize(agentId)) ?? null;
  }

  async setCard(agentId, card) {
    this.cards.set(normalize(agentId), String(card ?? "").slice(0, 2000));
  }

  /**
   * Drop a citizen's card/notes/history when they no longer exist.
   * Memory-leak plug, 2026-10-07.
   */
  async deleteCard(agentId) {
    const key = normalize(agentId);
    this.cards.delete(key);
    for (const map of [this.notes, this.history]) {
      for (const k of map.keys()) {
        if (k === key || k.startsWith(`${key}|`)) map.delete(k);
      }
    }
  }

  async getNotes(agentId, playerName) {
    return [...(this.notes.get(`${agentId}|${normalize(playerName)}`) ?? [])];
  }

  async addNote(agentId, playerName, note) {
    const key = `${agentId}|${normalize(playerName)}`;
    const list = this.notes.get(key) ?? [];
    const trimmed = String(note ?? "").trim().slice(0, 160);
    if (!trimmed || list.includes(trimmed)) return list;
    list.push(trimmed);
    while (list.length > MAX_NOTES_PER_PLAYER) list.shift();
    this.notes.set(key, list);
    return list;
  }

  async getHistory(agentId, playerName, limit = MAX_HISTORY_PER_PLAYER) {
    const list = this.history.get(`${agentId}|${normalize(playerName)}`) ?? [];
    return list.slice(-limit);
  }

  async pushExchange(agentId, playerName, playerText, replyText) {
    const key = `${agentId}|${normalize(playerName)}`;
    const list = this.history.get(key) ?? [];
    list.push({
      playerText: String(playerText ?? "").slice(0, 320),
      replyText: String(replyText ?? "").slice(0, 320),
      at: Date.now(),
    });
    while (list.length > MAX_HISTORY_PER_PLAYER) list.shift();
    this.history.set(key, list);
  }
}

// STUBBED: no sqlite driver on the game host yet (checked package.json).
// Swap this class out when better-sqlite3/node:sqlite lands; the interface is identical.
class SqliteMemoryStore extends MemoryStore {
  constructor(dbPath) {
    super();
    this.dbPath = dbPath;
    console.warn(
      `[llm-gateway] SqliteMemoryStore STUBBED (no sqlite driver on host, dbPath=${dbPath}) -- ` +
      `falling back to in-memory. Cards/notes will not survive a restart.`
    );
    this.fallback = new InMemoryMemoryStore();
  }
  getCard(...a) { return this.fallback.getCard(...a); }
  setCard(...a) { return this.fallback.setCard(...a); }
  deleteCard(...a) { return this.fallback.deleteCard(...a); }
  getNotes(...a) { return this.fallback.getNotes(...a); }
  addNote(...a) { return this.fallback.addNote(...a); }
  getHistory(...a) { return this.fallback.getHistory(...a); }
  pushExchange(...a) { return this.fallback.pushExchange(...a); }
}

module.exports = { MemoryStore, InMemoryMemoryStore, SqliteMemoryStore, MAX_HISTORY_PER_PLAYER };
