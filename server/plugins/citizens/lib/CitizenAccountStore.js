"use strict";

/**
 * CitizenAccountStore — per-citizen account files, like human player accounts.
 *
 * Replaces the 47 individual per-system JSON files (each holding all 3,111
 * citizens) with one file per citizen:
 *   server/data/saves/citizens/<kebab-name>.json
 *
 * Each file has namespaced blocks:
 *   {
 *     "version": 2,
 *     "username": "Maude Limber",
 *     "normalizedName": "maude limber",
 *     "gender": "female",
 *     "createdAt": 1234567890,
 *     "updatedAt": 1234567890,
 *     "identity": { "role": "...", "kingdomId": "...", ... },
 *     "appearance": { "gender": "female", "model": "...", ... },
 *     "skills": { "woodcutting": 83, ... },
 *     "aging": { ... },
 *     ...
 *   }
 *
 * Jon 2026-10-13: Citizens should save like human player accounts, not
 * sharded by system. Female names → female character models and vice versa.
 */

const fs = require("fs");
const path = require("path");

const ACCOUNT_VERSION = 2;

function getCitizenDir() {
  // Mirrors the existing save path pattern: <cwd>/data/saves/citizens/
  // Falls back to server/data/saves/citizens/ if cwd differs.
  const candidates = [
    path.join(process.cwd(), "data", "saves", "citizens"),
    path.join(process.cwd(), "server", "data", "saves", "citizens"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  // Default: create under cwd
  return candidates[0];
}

function kebabCase(normalizedName) {
  return normalizedName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function accountPath(normalizedName) {
  return path.join(getCitizenDir(), `${kebabCase(normalizedName)}.json`);
}

function ensureDir() {
  const dir = getCitizenDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Load a citizen's full account. Returns null if no file exists.
 * Uses an in-memory cache for performance (cleared on save).
 */
const _cache = new Map();

function load(normalizedName) {
  const key = normalizedName.toLowerCase().trim();
  if (_cache.has(key)) {
    return _cache.get(key);
  }
  const file = accountPath(key);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    _cache.set(key, data);
    return data;
  } catch (err) {
    // Corrupt file — don't cache, return null so caller can regenerate
    return null;
  }
}

/**
 * Save a citizen's full account. Creates directory if needed.
 */
function save(normalizedName, account) {
  const key = normalizedName.toLowerCase().trim();
  ensureDir();
  account.updatedAt = Date.now();
  if (!account.version) account.version = ACCOUNT_VERSION;
  if (!account.normalizedName) account.normalizedName = key;
  const file = accountPath(key);
  fs.writeFileSync(file, JSON.stringify(account, null, 1));
  _cache.set(key, account);
  return true;
}

/**
 * Check if an account file exists (without loading it).
 */
function exists(normalizedName) {
  const key = normalizedName.toLowerCase().trim();
  if (_cache.has(key)) return true;
  return fs.existsSync(accountPath(key));
}

/**
 * Get a single namespaced block from a citizen's account.
 * Returns {} if the citizen or block doesn't exist.
 */
function getBlock(normalizedName, blockName) {
  const account = load(normalizedName);
  if (!account) return {};
  return account[blockName] ?? {};
}

/**
 * Set a single namespaced block in a citizen's account.
 * Creates a minimal account if none exists.
 */
function setBlock(normalizedName, blockName, data) {
  let account = load(normalizedName);
  if (!account) {
    account = {
      version: ACCOUNT_VERSION,
      username: normalizedName, // Will be corrected on next full save
      normalizedName: normalizedName.toLowerCase().trim(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  account[blockName] = data;
  return save(normalizedName, account);
}

/**
 * Create a new account for a citizen with the given details.
 * Used during migration and for newly generated citizens.
 */
function createAccount({ username, gender, role, kingdomId, home, traits, appearance }) {
  const normalizedName = username.toLowerCase().trim();
  const account = {
    version: ACCOUNT_VERSION,
    username,
    normalizedName,
    gender: gender ?? "unknown",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    identity: {
      role: role ?? "commoner",
      kingdomId: kingdomId ?? null,
      home: home ?? null,
      traits: traits ?? [],
    },
    appearance: appearance ?? { gender: gender ?? "unknown" },
    skills: {},
    aging: {},
    health: {},
  };
  save(normalizedName, account);
  return account;
}

/**
 * Clear the in-memory cache. Useful for testing or after bulk operations.
 */
function clearCache() {
  _cache.clear();
}

/**
 * Dirty check: does the candidate account differ from the last saved/loaded
 * version? Compares everything except updatedAt, so the director can sweep
 * the roster each save cycle without rewriting thousands of unchanged files.
 * Returns true when the citizen has no cached account (never saved this
 * session) — the caller should save to create the file.
 */
function hasChanged(normalizedName, account) {
  const key = normalizedName.toLowerCase().trim();
  const cached = _cache.get(key);
  if (!cached) return true;
  const strip = (a) => {
    const copy = { ...a };
    delete copy.updatedAt;
    return copy;
  };
  return JSON.stringify(strip(cached)) !== JSON.stringify(strip(account));
}

/**
 * List all account files (for migration/verification).
 * Returns array of normalized names (derived from filenames).
 */
function listAccounts() {
  const dir = getCitizenDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5).replace(/-/g, " "));
}

module.exports = {
  ACCOUNT_VERSION,
  kebabCase,
  accountPath,
  load,
  save,
  exists,
  getBlock,
  setBlock,
  createAccount,
  clearCache,
  hasChanged,
  listAccounts,
};
