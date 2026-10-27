/** Explorer's ring allowances replenish on the next login after midnight (Wiki).
 * Other diary rewards may roll their shared day forward while this player stays online.
 */
const Common = require("./Common.DiaryRewards");
const DAILY_ATTRIBUTE = "diary-rewards:explorers-ring-daily";
const ENERGY_KEY = "explorers-ring-energy";
const ALCHEMY_KEY = "explorers-ring-alchemy";
const field = (key) => {
  if (key === ENERGY_KEY) return "energy";
  if (key === ALCHEMY_KEY) return "alchemy";
  throw new Error("Unknown Explorer's ring allowance");
};
const count = (value, max) =>
  Number.isFinite(Number(value))
    ? Math.max(0, Math.min(max, Math.floor(Number(value))))
    : 0;
function state(player) {
  let saved = player.getAttribute(DAILY_ATTRIBUTE);
  if (saved && typeof saved === "object") return saved;
  const legacy = player.getAttribute(Common.DAILY_ATTRIBUTE);
  saved = {
    day: typeof legacy?.day === "string" ? legacy.day : Common.today(),
    energy: count(legacy?.counts?.[ENERGY_KEY], 4),
    alchemy: count(
      legacy?.counts?.[ALCHEMY_KEY],
      Common.DATA.explorersRing.alchemyPerDay,
    ),
  };
  player.setAttribute(DAILY_ATTRIBUTE, saved);
  return saved;
}
function uses(player, key) {
  return count(
    state(player)[field(key)],
    key === ENERGY_KEY ? 4 : Common.DATA.explorersRing.alchemyPerDay,
  );
}
function save(player) {
  Common.api.emitCustomEvent("persistence:save", {
    player,
    reason: "explorers-ring-allowance",
  });
}
function use(player, key) {
  const previous = state(player),
    used = uses(player, key) + 1;
  player.setAttribute(DAILY_ATTRIBUTE, { ...previous, [field(key)]: used });
  save(player);
  return used;
}
function login({ player }) {
  const previous = player.getAttribute(DAILY_ATTRIBUTE);
  let current = state(player);
  if (current.day !== Common.today()) {
    current = { day: Common.today(), energy: 0, alchemy: 0 };
    player.setAttribute(DAILY_ATTRIBUTE, current);
  }
  if (previous !== current) save(player);
}
function attach(api) {
  api.persistAttribute(DAILY_ATTRIBUTE, null);
  api.onPlayerLogin(login);
}
module.exports = {
  DAILY_ATTRIBUTE,
  ENERGY_KEY,
  ALCHEMY_KEY,
  uses,
  use,
  attach,
};
