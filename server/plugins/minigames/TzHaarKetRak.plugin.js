/**
 * TzHaar-Ket-Rak's Challenges (https://oldschool.runescape.wiki/w/TzHaar-Ket-Rak%27s_Challenges),
 * from plugins/minigames/data/tzhaar-ket-rak.json: TzHaar-Ket-Rak's talk and challenge menu, the
 * challenges against one to six JalTok-Jads, and their rewards. Each lives in ./tzhaarketrak/.
 */
const Common = require("./tzhaarketrak/Common.TzHaarKetRak");
const Dialogue = require("./tzhaarketrak/Dialogue.TzHaarKetRak");
const Challenge = require("./tzhaarketrak/Challenge.TzHaarKetRak");
const Rewards = require("./tzhaarketrak/Rewards.TzHaarKetRak");

module.exports = {
  name: "TzHaarKetRak",
  members: true,
  register(api) {
    Common.init(api);
    Dialogue.attach(api, { start: Challenge.start });
    Challenge.attach(api, { lastJadDown: Rewards.lastJadDown, completed: Rewards.completed, failed: Rewards.failed, refused: Rewards.refused });
    Rewards.attach(api);
  },
};
