"use strict";

const Events = require("./random-events/Common.RandomEvents");
const Plant = require("./random-events/StrangePlant.RandomEvents");

module.exports = {
  name: "StrangePlant",
  members: true,
  register(api) {
    api.onCustomEvent(Events.DEFINITIONS_EVENT, Plant.addDefinition.bind(null, api));
    api.onNpcInteraction("Strange plant", { Pick: Events.talk, Dismiss: Events.dismiss });
  },
};
