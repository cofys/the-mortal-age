"use strict";

/**
 * SqlitePlayerBackup.test — players.sqlite VACUUM INTO snapshots + rotation.
 *
 * Runs the save writer's message handler on the main thread (module exports createWriter),
 * against throwaway databases under the OS temp dir — never the real data/saves tree.
 */
const assert = require("node:assert/strict");
const { after, describe, it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const {
  createWriter,
  backupFilename,
  backupDir,
  uniqueBackupPath,
  rotateBackups,
  BACKUP_KEEP,
} = require("./SqliteSaveWorker");

const SKILL_COUNT = 24;
const PLAYER_SAVES_DDL = `
  CREATE TABLE player_saves (
    username TEXT PRIMARY KEY,
    save_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const tempDirs = [];
const openDatabases = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tma-player-backup-"));
  tempDirs.push(dir);
  return dir;
}

function openDatabase(file) {
  const db = new DatabaseSync(file);
  openDatabases.push(db);
  return db;
}

after(() => {
  for (const db of openDatabases.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed by a test on purpose.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Minimal save JSON that passes validateSerializedSave. */
function validSaveJson(skillCount, x, y) {
  const items = (n) => Array.from({ length: n }, () => ({ id: 0, amount: 0 }));
  const levels = (n) => Array.from({ length: n }, () => 1);
  return JSON.stringify({
    position: { x, y, z: 0 },
    inventory: items(28),
    equipment: items(14),
    skills: { level: levels(skillCount), maxLevel: levels(skillCount), experience: levels(skillCount) },
  });
}

function writeSave(write, nextSeq, username, json) {
  const answer = write({
    seq: nextSeq(),
    username,
    savedAt: new Date().toISOString(),
    writes: [{ kind: "row", json }],
  });
  assert.equal(answer.ok, true, `save for ${username} should commit`);
  return answer;
}

function rowMap(db) {
  return new Map(
    db
      .prepare("SELECT username, save_json AS saveJson FROM player_saves")
      .all()
      .map((row) => [row.username, row.saveJson])
  );
}

/** PRAGMA integrity_check via prepare().all() (exec() returns undefined for it here). */
function integrityOk(db) {
  const rows = db.prepare("PRAGMA integrity_check").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].integrity_check, "ok");
}

describe("backup filename and directory helpers", () => {
  it("backupFilename is UTC YYYYMMDD-HHMMSSZ, fixed width", () => {
    assert.equal(backupFilename(new Date(Date.UTC(2026, 9, 10, 7, 23, 45))), "players-20261010-072345Z.sqlite");
  });

  it("backupDir is <db-dir>/backups", () => {
    assert.equal(backupDir("/x/data/saves/players.sqlite"), path.join("/x/data/saves", "backups"));
  });

  it("uniqueBackupPath appends -N on a timestamp collision", () => {
    const dir = tempDir();
    const when = new Date(Date.UTC(2026, 9, 10, 7, 23, 45));
    const first = uniqueBackupPath(dir, when);
    assert.equal(path.basename(first), "players-20261010-072345Z.sqlite");
    fs.writeFileSync(first, "x");
    assert.equal(path.basename(uniqueBackupPath(dir, when)), "players-20261010-072345Z-1.sqlite");
  });

  it("rotateBackups on a missing directory is a no-op", () => {
    assert.deepEqual(rotateBackups(path.join(tempDir(), "nope"), 12), { kept: 0, pruned: 0 });
  });
});

describe("takeBackup via the writer message handler", () => {
  it("backup copies a valid file: integrity_check ok, rows match", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "players.sqlite");
    const db = openDatabase(dbPath);
    db.exec(PLAYER_SAVES_DDL);
    const write = createWriter(db, SKILL_COUNT, dbPath);

    let seq = 1;
    const nextSeq = () => seq++;
    const saves = {
      alice: validSaveJson(SKILL_COUNT, 3200, 3200),
      bob: validSaveJson(SKILL_COUNT, 3100, 3100),
    };
    for (const [username, json] of Object.entries(saves)) writeSave(write, nextSeq, username, json);

    const answer = write({ type: "backup", seq: nextSeq() });
    assert.equal(answer.backup, true);
    assert.equal(answer.ok, true);
    assert.match(path.basename(answer.path), /^players-\d{8}-\d{6}Z\.sqlite$/);
    assert.ok(fs.existsSync(answer.path), "backup file should exist");
    assert.deepEqual(
      { kept: answer.kept, pruned: answer.pruned },
      { kept: 1, pruned: 0 },
      "answer carries rotation counts"
    );

    const copy = openDatabase(answer.path);
    integrityOk(copy);
    const rows = rowMap(copy);
    assert.equal(rows.size, 2, "every player row is present");
    for (const [username, json] of Object.entries(saves)) {
      assert.equal(rows.get(username), json, `${username}'s save is complete in the backup`);
    }
  });

  it("backup fails cleanly when the database can't be snapshotted", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "players.sqlite");
    const db = openDatabase(dbPath);
    db.exec(PLAYER_SAVES_DDL);
    const write = createWriter(db, SKILL_COUNT, dbPath);
    db.close();
    const answer = write({ type: "backup", seq: 1 });
    assert.equal(answer.backup, true);
    assert.equal(answer.ok, false);
    assert.equal(typeof answer.error, "string");
  });
});

describe("rotation", () => {
  it("seeds 15 fake backups, keeps the 12 newest", () => {
    const dir = tempDir();
    const names = [];
    for (let i = 0; i < 15; i++) {
      const name = backupFilename(new Date(Date.UTC(2026, 0, 1 + i, 0, 0, 0)));
      names.push(name);
      fs.writeFileSync(path.join(dir, name), `fake-${i}`);
    }
    // A non-backup file in the dir must be left alone.
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");

    const { kept, pruned } = rotateBackups(dir, BACKUP_KEEP);
    assert.equal(kept, 12);
    assert.equal(pruned, 3);
    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith(".sqlite")).sort();
    assert.deepEqual(remaining, names.slice(3).sort(), "the 12 newest backups remain");
    assert.ok(fs.existsSync(path.join(dir, "notes.txt")), "non-backup files are untouched");
  });
});

describe("no mid-save race", () => {
  it("interleaved saves and backups each capture a fully consistent snapshot", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "players.sqlite");
    const db = openDatabase(dbPath);
    db.exec(PLAYER_SAVES_DDL);
    const write = createWriter(db, SKILL_COUNT, dbPath);

    let seq = 1;
    const nextSeq = () => seq++;
    const snapshots = [];
    for (let i = 0; i < 5; i++) {
      const username = `player${i}`;
      const json = validSaveJson(SKILL_COUNT, 3000 + i, 3000 + i);
      writeSave(write, nextSeq, username, json);
      const answer = write({ type: "backup", seq: nextSeq() });
      assert.equal(answer.ok, true);
      snapshots.push({ expectedRows: i + 1, path: answer.path });
    }

    // Each backup holds exactly the saves committed before it — no partial,
    // half-written, or future rows: every row is present and complete.
    for (const [index, snapshot] of snapshots.entries()) {
      const copy = openDatabase(snapshot.path);
      integrityOk(copy);
      const rows = rowMap(copy);
      assert.equal(rows.size, snapshot.expectedRows, `backup ${index} has exactly the committed rows`);
      for (let i = 0; i < snapshot.expectedRows; i++) {
        const parsed = JSON.parse(rows.get(`player${i}`));
        assert.equal(typeof parsed.position.x, "number", `player${i} row is complete in backup ${index}`);
        assert.equal(parsed.inventory.length, 28);
        assert.equal(parsed.skills.level.length, SKILL_COUNT);
      }
    }

    // The source database is untouched by the backups (VACUUM INTO only reads).
    assert.equal(rowMap(db).size, 5);
  });
});
