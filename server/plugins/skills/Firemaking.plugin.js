const Logs = require("./firemaking/Logs.Firemaking");

module.exports = {
  ...Logs,
  name: "Firemaking",
  register(api) {
    Logs.attach(api);
  },
};
