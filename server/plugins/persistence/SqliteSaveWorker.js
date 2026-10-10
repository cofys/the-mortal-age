/**
 * The SQLite backend's writer, on its own thread (worker_threads) so the game tick never waits on
 * the disk. It owns the only connection that writes: each message is one player's writes (their
 * save row and history copies), validated, then committed in one transaction, and answered with
 * `{ seq, username, ok, error? }`. A `{ type: "backup" }` message instead snapshots the whole
 * database with `VACUUM INTO` into `<db-dir>/backups/players-<UTC YYYYMMDD-HHMMSS>Z.sqlite` and
 * rotates to the newest 12, answered with `{ seq, backup: true, ok, path?, kept?, pruned?, error? }`.
 * Messages are handled in the order they were sent, one at a time: a backup runs between messages,
 * when no transaction is open, so it can never interleave mid-save.
 * See SqlitePlayerPersistence.plugin.js and docs/player-saves.md.
 */
const fs = require("fs");
const path = require("path");
const { isMainThread, parentPort, workerData } = require("worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { SqliteSaveHistory } = require("./SqliteSaveHistory");
const { validateSerializedSave } = require("./validateSave");

const PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
`;

/** How many backup snapshots are kept; older ones are deleted after each backup. */
const BACKUP_KEEP = 12;

/**
 * Backup filename for a moment in time: players-YYYYMMDD-HHMMSSZ.sqlite (UTC, fixed width, so
 * lexicographic order is chronological order).
 */
function backupFilename(when = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `players-${when.getUTCFullYear()}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}-` +
    `${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}${pad(when.getUTCSeconds())}Z.sqlite`
  );
}

/** Where backups for a database live: `<dirname-of-databasePath>/backups/`. */
function backupDir(databasePath) {
  return path.join(path.dirname(path.resolve(databasePath)), "backups");
}

/**
 * A target path for a backup that doesn't overwrite an existing file: if the timestamp collides
 * (two backups in the same second), `players-<stamp>-1.sqlite`, `-2`, ...
 */
function uniqueBackupPath(dir, when = new Date()) {
  const stem = backupFilename(when).replace(/\.sqlite$/, "");
  let candidate = path.join(dir, `${stem}.sqlite`);
  for (let n = 1; fs.existsSync(candidate); n++) {
    candidate = path.join(dir, `${stem}-${n}.sqlite`);
  }
  return candidate;
}

/**
 * Keeps the `keep` newest `players-*.sqlite` in `dir`, deleting older ones.
 * Returns `{ kept, pruned }`.
 */
function rotateBackups(dir, keep = BACKUP_KEEP) {
  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter((file) => file.startsWith("players-") && file.endsWith(".sqlite"))
      .sort();
  } catch {
    return { kept: 0, pruned: 0 };
  }
  const pruned = files.splice(0, Math.max(0, files.length - keep));
  for (const file of pruned) {
    try {
      fs.unlinkSync(path.join(dir, file));
    } catch {
      // Already gone (raced a manual delete); not fatal.
    }
  }
  return { kept: files.length, pruned: pruned.length };
}

/**
 * Snapshots `database` with `VACUUM INTO` and rotates the backups.
 * Call only when no transaction is open (between writer messages). Returns `{ path, kept, pruned }`.
 */
function takeBackup(database, databasePath, when = new Date()) {
  const dir = backupDir(databasePath);
  fs.mkdirSync(dir, { recursive: true });
  const target = uniqueBackupPath(dir, when);
  // VACUUM INTO takes no bound parameters; quote the path by doubling single quotes.
  database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const { kept, pruned } = rotateBackups(dir, BACKUP_KEEP);
  return { path: target, kept, pruned };
}

/**
 * Returns `write(message) -> answer` for a connection: `message.writes` are
 * `{ kind: "row", json }` (the player's save) and `{ kind: "history", json, reason }` (a copy),
 * validated and committed in one transaction. A `{ type: "backup" }` message snapshots the whole
 * database instead (VACUUM INTO + rotation). The backend also uses this on the game thread if
 * the writer thread can't run.
 */
function createWriter(database, skillCount, databasePath) {
  const history = new SqliteSaveHistory(database);
  const writeRow = database.prepare(`
    INSERT INTO player_saves (username, save_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      save_json = excluded.save_json,
      updated_at = excluded.updated_at
  `);
  function commit({ username, savedAt, writes }) {
    for (const write of writes) {
      if (write.kind === "row") validateSerializedSave(write.json, username, skillCount);
    }
    database.exec("BEGIN");
    try {
      for (const write of writes) {
        if (write.kind === "row") writeRow.run(username, write.json, savedAt);
        else history.record(username, write.json, write.reason, savedAt);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  return (message) => {
    if (message && message.type === "backup") {
      try {
        const { path: backupPath, kept, pruned } = takeBackup(database, databasePath);
        return { seq: message.seq, backup: true, ok: true, path: backupPath, kept, pruned };
      } catch (error) {
        return {
          seq: message.seq,
          backup: true,
          ok: false,
          error: error?.message ?? String(error),
        };
      }
    }
    try {
      commit(message);
      return { seq: message.seq, username: message.username, ok: true };
    } catch (error) {
      return { seq: message.seq, username: message.username, ok: false, error: error?.message ?? String(error) };
    }
  };
}

if (!isMainThread && parentPort) {
  const database = new DatabaseSync(workerData.databasePath);
  database.exec(PRAGMAS);
  const write = createWriter(database, workerData.skillCount, workerData.databasePath);
  parentPort.on("message", (message) => parentPort.postMessage(write(message)));
  parentPort.postMessage({ ready: true });
}

module.exports = {
  createWriter,
  backupFilename,
  backupDir,
  uniqueBackupPath,
  rotateBackups,
  takeBackup,
  BACKUP_KEEP,
};
