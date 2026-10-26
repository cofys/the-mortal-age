const attachRecoil = require("./suffering/Recoil.RingOfSuffering");

module.exports = {
  name: "RingOfSuffering",
  members: true,
  _test: attachRecoil._test,
  register(api) {
    attachRecoil(api);
  },
};
