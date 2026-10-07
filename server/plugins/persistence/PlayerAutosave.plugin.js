/**
 * PlayerAutosave — periodic autosave for online players.
 *
 * Saves only happen on logout, shutdown, or manual ::saveall. If the server
 * crashes (or is killed hard during a deploy), all progress since the last
 * logout is lost. This plugin saves every online player every 5 minutes so
 * at most 5 minutes of progress is ever at risk.
 *
 * Uses World.savePlayers() which skips bots (bot-skip-persistence) and logs
 * per-player failures without aborting the batch.
 */

const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;

let autosaveTimer = null;
let worldRef = null;

function runAutosave() {
  try {
    if (worldRef) {
      worldRef.savePlayers();
    }
  } catch (err) {
    console.error("[persistence] autosave failed", err);
  }
}

function startAutosave() {
  if (autosaveTimer) {
    return;
  }
  autosaveTimer = setInterval(runAutosave, AUTOSAVE_INTERVAL_MS);
  autosaveTimer.unref?.();
}

module.exports = {
  name: "PlayerAutosave",
  register(api) {
    worldRef = api.getWorld();
    api.onServerStartup(startAutosave);
  },
};
