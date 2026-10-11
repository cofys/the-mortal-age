/**
 * The global wind: direction + strength, shifting every ~30 minutes. Sailing with the wind
 * is faster (+50%) and trains faster (+25% XP); sailing against it is slower (-30%).
 *
 * Pure logic (no engine calls) so it unit-tests without a running server.
 *
 * Angle convention (HeadingUtils): 2048 units, 0 = south, 512 = west, 1024 = north,
 * 1536 = east, increasing clockwise. A wind "from the north" blows towards the south, so a
 * boat heading south (angle 0) has the wind behind it.
 */
const ANGLE_UNITS = 2048;

/** The 8 compass points the wind blows FROM, as angles. */
const WIND_ANGLES = [0, 256, 512, 768, 1024, 1280, 1536, 1792];
const WIND_NAMES = [
  "south", "south-west", "west", "north-west",
  "north", "north-east", "east", "south-east",
];
/** Strength 1-3: light, steady, strong. */
const WIND_STRENGTH_NAMES = ["light", "steady", "strong"];

/** Ticks between wind shifts: ~30 minutes at 0.6s a tick. */
const WIND_SHIFT_TICKS = 3000;

/** Speed multiplier sailing with / against the wind. */
const WITH_WIND_SPEED = 1.5;
const AGAINST_WIND_SPEED = 0.7;
/** XP multiplier when the wind is behind the boat. */
const WITH_WIND_XP = 1.25;
/** Within this many angle units of dead astern / dead ahead counts as with / against. */
const WIND_ARC = 256;

function normalize(angle) {
  return ((Math.trunc(angle) % ANGLE_UNITS) + ANGLE_UNITS) % ANGLE_UNITS;
}

/** Rolls a new wind: direction 0-7 and strength 1-3. */
function rollWind(random = Math.random) {
  return {
    dir: Math.floor(random() * WIND_ANGLES.length),
    strength: 1 + Math.floor(random() * WIND_STRENGTH_NAMES.length),
  };
}

function windAngle(wind) {
  return WIND_ANGLES[normalize(wind.dir) % WIND_ANGLES.length];
}

function describeWind(wind) {
  const name = WIND_NAMES[normalize(wind.dir) % WIND_NAMES.length] ?? "south";
  const strength = WIND_STRENGTH_NAMES[Math.min(Math.max(wind.strength - 1, 0), 2)];
  return `blowing from the ${name}, ${strength}`;
}

/**
 * How the wind treats a boat on `heading` (angle): "with" when the heading is within
 * WIND_ARC of dead astern (away from where the wind comes from), "against" within WIND_ARC
 * of dead ahead, "across" otherwise.
 */
function windAspect(heading, wind) {
  const astern = normalize(windAngle(wind) + ANGLE_UNITS / 2);
  const diff = Math.abs(normalize(heading - astern));
  const offAstern = Math.min(diff, ANGLE_UNITS - diff);
  if (offAstern <= WIND_ARC) return "with";
  const offAhead = Math.min(
    Math.abs(normalize(heading - windAngle(wind))),
    ANGLE_UNITS - Math.abs(normalize(heading - windAngle(wind))),
  );
  if (offAhead <= WIND_ARC) return "against";
  return "across";
}

/** The boat's speed multiplier for its heading under this wind. */
function windSpeedFactor(heading, wind) {
  const aspect = windAspect(heading, wind);
  if (aspect === "with") return WITH_WIND_SPEED;
  if (aspect === "against") return AGAINST_WIND_SPEED;
  return 1;
}

/** The Sailing XP multiplier for the boat's heading under this wind. */
function windXpFactor(heading, wind) {
  return windAspect(heading, wind) === "with" ? WITH_WIND_XP : 1;
}

module.exports = {
  WIND_SHIFT_TICKS,
  WITH_WIND_SPEED,
  AGAINST_WIND_SPEED,
  WITH_WIND_XP,
  WIND_ARC,
  rollWind,
  describeWind,
  windAspect,
  windSpeedFactor,
  windXpFactor,
  windAngle,
  WIND_NAMES,
};
