const WALK_STEP_SIZE = 1;
const WALK_CHANCE_PER_TICK = 0.03;

function shouldTakeStressBotStep(random = Math.random) {
  return random() < WALK_CHANCE_PER_TICK;
}

function nextStressBotActivityTick(currentTick, minDelay, maxDelay, random = Math.random) {
  return currentTick + minDelay + Math.floor(random() * (maxDelay - minDelay + 1));
}

function randomClippedStepWithinBounds(player, bounds) {
  const location = player.getLocation();
  const x = location.getX();
  const y = location.getY();
  const steps = [
    [-WALK_STEP_SIZE, 0],
    [WALK_STEP_SIZE, 0],
    [0, -WALK_STEP_SIZE],
    [0, WALK_STEP_SIZE],
  ];
  let [dx, dy] = steps[Math.floor(Math.random() * steps.length)];

  if (x < bounds.minX) [dx, dy] = [WALK_STEP_SIZE, 0];
  else if (x > bounds.maxX) [dx, dy] = [-WALK_STEP_SIZE, 0];
  else if (y < bounds.minY) [dx, dy] = [0, WALK_STEP_SIZE];
  else if (y > bounds.maxY) [dx, dy] = [0, -WALK_STEP_SIZE];
  else {
    if (x + dx < bounds.minX || x + dx > bounds.maxX) dx = -dx;
    if (y + dy < bounds.minY || y + dy > bounds.maxY) dy = -dy;
  }

  const queue = player.getMovementQueue();
  if (queue.canWalk(dx, dy)) queue.walkStep(dx, dy);
}

module.exports = {
  nextStressBotActivityTick,
  randomClippedStepWithinBounds,
  shouldTakeStressBotStep,
};
