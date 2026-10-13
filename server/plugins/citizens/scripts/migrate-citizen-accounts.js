#!/usr/bin/env node
"use strict";

/**
 * Migrate citizen data from per-system JSON files to per-citizen account files.
 *
 * Jon 2026-10-13: "Not much data to lose... I wouldn't mind more unique names."
 *
 * This script:
 * 1. Scans old per-system files for citizens with actual data (XP > 0, etc.)
 * 2. Creates per-citizen account files for them, preserving their data
 * 3. Archives the old files (does NOT delete — rollback safe)
 *
 * Citizens without data get fresh accounts on next spawn (with new unique
 * names from the expanded 66k pool and gender-matched appearance).
 *
 * Usage: node scripts/migrate-citizen-accounts.js [--dry-run]
 */

const fs = require("fs");
const path = require("path");

// Find the server root (where data/saves lives)
function findServerRoot() {
  let dir = process.cwd();
  while (dir !== "/") {
    if (fs.existsSync(path.join(dir, "server", "data", "saves"))) {
      return path.join(dir, "server");
    }
    if (fs.existsSync(path.join(dir, "data", "saves"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error("Cannot find server data directory");
}

const SERVER_ROOT = findServerRoot();
const SAVES_DIR = path.join(SERVER_ROOT, "data", "saves");
const CITIZEN_DIR = path.join(SAVES_DIR, "citizens");
const ARCHIVE_DIR = path.join(SAVES_DIR, "_archive_20261013");

// Per-citizen system files to migrate (keyed by normalized name)
const PER_CITIZEN_FILES = [
  "citizen-skills.json",
  "citizen-aging.json",
  "citizen-health.json",
  "citizen-homes.json",
  "citizen-memory.json",
  "citizen-journal.json",
  "citizen-reputation.json",
  "citizen-social-bonds.json",
  "citizen-kin.json",
  "citizen-careers.json",
];

function kebabCase(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function loadJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`Citizen account migration ${dryRun ? "(DRY RUN)" : ""}`);
  console.log(`Server root: ${SERVER_ROOT}`);

  // Step 1: Scan for citizens with data
  const citizensWithData = new Map(); // normalizedName -> {blocks: {}}

  for (const filename of PER_CITIZEN_FILES) {
    const file = path.join(SAVES_DIR, filename);
    const data = loadJsonSafe(file);
    if (!data || !data.citizens) continue;

    const blockName = filename.replace("citizen-", "").replace(".json", "").replace(/-/g, "");
    // Map filename to block name: skills, aging, health, homes, memory, journal, etc.
    const blockMap = {
      skills: "skills",
      aging: "aging",
      health: "health",
      homes: "homes",
      memory: "memory",
      journal: "journal",
      reputation: "reputation",
      socialbonds: "socialBonds",
      kin: "kin",
      careers: "careers",
    };
    const block = blockMap[blockName] || blockName;

    for (const [name, citizenData] of Object.entries(data.citizens)) {
      // Check if this citizen has non-empty data
      const hasData = citizenData && Object.keys(citizenData).length > 0 &&
        JSON.stringify(citizenData) !== "{}" &&
        JSON.stringify(citizenData) !== '{"xp":{}}';

      if (hasData) {
        if (!citizensWithData.has(name)) {
          citizensWithData.set(name, { blocks: {} });
        }
        citizensWithData.get(name).blocks[block] = citizenData;
      }
    }
  }

  console.log(`\nFound ${citizensWithData.size} citizens with data to preserve:`);
  for (const [name, data] of citizensWithData) {
    console.log(`  - ${name}: ${Object.keys(data.blocks).join(", ")}`);
  }

  if (dryRun) {
    console.log("\nDry run complete. No files written.");
    return;
  }

  // Step 2: Create account directory
  if (!fs.existsSync(CITIZEN_DIR)) {
    fs.mkdirSync(CITIZEN_DIR, { recursive: true });
    console.log(`\nCreated: ${CITIZEN_DIR}`);
  }

  // Step 3: Write account files
  let written = 0;
  for (const [normalizedName, data] of citizensWithData) {
    // Reconstruct display name (title case)
    const username = normalizedName.split(" ").map(w =>
      w.charAt(0).toUpperCase() + w.slice(1)
    ).join(" ");

    const account = {
      version: 2,
      username,
      normalizedName,
      gender: "unknown", // Will be set on next spawn from name generation
      createdAt: Date.now(),
      updatedAt: Date.now(),
      identity: {},
      appearance: {},
      ...data.blocks, // Spread the preserved blocks (skills, aging, etc.)
    };

    // Handle skills block specially: old format is {xp: {skill: xp}}, new is {skill: xp}
    if (account.skills && account.skills.xp) {
      account.skills = account.skills.xp;
    }

    const file = path.join(CITIZEN_DIR, `${kebabCase(normalizedName)}.json`);
    fs.writeFileSync(file, JSON.stringify(account, null, 1));
    written++;
  }
  console.log(`\nWrote ${written} account files to ${CITIZEN_DIR}`);

  // Step 4: Archive old files (don't delete)
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
  let archived = 0;
  for (const filename of PER_CITIZEN_FILES) {
    const src = path.join(SAVES_DIR, filename);
    const dst = path.join(ARCHIVE_DIR, filename);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      archived++;
    }
  }
  console.log(`Archived ${archived} old files to ${ARCHIVE_DIR}`);
  console.log("\nMigration complete. Old files archived (not deleted) for rollback safety.");
  console.log("Citizens without data will get fresh accounts on next spawn.");
}

main();
