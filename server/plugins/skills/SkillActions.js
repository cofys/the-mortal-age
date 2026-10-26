/** Holds a skill's existing session through a level-up dialogue, without restarting its work. */
function pauseForLevelUp(event, sessions, stop, onResume) {
  const { player } = event;
  const session = sessions.get(player);
  if (!session) return;
  if (!event.pause) return stop(player);
  session.levelUpPaused = true;
  event.pause(session, () => {
    if (sessions.get(player) !== session) return;
    session.levelUpPaused = false;
    onResume?.(session);
  }, () => {
    if (sessions.get(player) === session) stop(player);
  });
}

module.exports = { pauseForLevelUp };
