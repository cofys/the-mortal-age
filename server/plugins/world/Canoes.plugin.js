module.exports = {
  name: "Canoes",
  _test: require("./canoes/Network.Canoes")._test,
  register(api) {
    require("./canoes/Network.Canoes")(api);
  },
};
