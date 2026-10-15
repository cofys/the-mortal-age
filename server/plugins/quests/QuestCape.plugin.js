const attachQuestCape = require("./QuestCape.QuestCape");

module.exports = {
  name: "QuestCape",
  members: true,
  register(api) {
    attachQuestCape(api);
  },
};
