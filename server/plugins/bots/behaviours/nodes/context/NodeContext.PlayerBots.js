function resolveBotNodeContext(context, botStatesByName, options = {}) {
  const {
    requiredMode = null,
    requireRegistered = true,
    requireNotBusy = true,
    requireNoTraversalTransition = true,
    requireNotInCombat = true,
  } = options;

  const player = context?.player;
  if (!player) {
    return null;
  }
  let cached = context?.__resolvedBotNodeContext;
  if (!cached || cached.player !== player) {
    const username = player.getUsername?.();
    const state = username ? botStatesByName.get(username) : null;
    const combat = player.getCombat?.();
    cached = {
      player,
      username,
      state,
      isRegistered: player.isRegistered(),
      isBusy: player.busy(),
      inCombat: !!(
        combat?.getTarget?.() ||
        combat?.getAttacker?.() ||
        player.getCombatFollowing?.()
      ),
      hasTraversalTransition: !!state?.awaitingDitchTransition,
      nowMs: Number.isFinite(context?.nowMs) ? context.nowMs : Date.now(),
    };
    context.__resolvedBotNodeContext = cached;
  }

  if (requireRegistered && !cached.isRegistered) {
    return null;
  }
  if (!cached.username || !cached.state) {
    return null;
  }
  if (requireNotBusy && cached.isBusy) {
    return null;
  }
  if (requireNotInCombat && cached.inCombat) {
    return null;
  }
  if (requireNoTraversalTransition && cached.hasTraversalTransition) {
    return null;
  }
  if (requiredMode && cached.state.mode !== requiredMode) {
    return null;
  }

  return {
    player,
    state: cached.state,
    username: cached.username,
    nowMs: cached.nowMs,
  };
}

module.exports = {
  resolveBotNodeContext,
};
