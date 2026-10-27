module.exports = {
  name: "Bonecrusher",
  members: true,
  register(api) {
    require("./bonecrusher/Charges.Bonecrusher")(api);
    require("./bonecrusher/Crushing.Bonecrusher")(api);
  },
};
