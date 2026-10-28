module.exports = {
  name: "KalphiteQueen",
  members: true,
  register(api) {
    require("./kalphitequeen/Encounter.KalphiteQueen")(api);
  },
};
