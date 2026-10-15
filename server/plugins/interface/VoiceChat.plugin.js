"use strict";

module.exports = {
  name: "VoiceChat",
  enabled: false,
  register(api) {
    require("./Signalling.VoiceChat")(api);
  },
};
