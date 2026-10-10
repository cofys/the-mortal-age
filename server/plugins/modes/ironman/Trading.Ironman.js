/**
 * No trading with other players, either way (captured): the Ironman asking is told "You are an
 * Ironman. You stand alone."; anyone asking an Ironman is told "<name> is an Ironman. He/She
 * stands alone."
 */
const Common = require("./Common.Ironman");

function tradeRequest(event) {
  const { player, target } = event;
  if (Common.isIron(player)) {
    player.sendMessage(Common.message("tradeSelf"));
    event.handled = true;
    return;
  }
  if (Common.isIron(target)) {
    const pronoun = target.getAppearance?.().isMale?.() === false ? "She" : "He";
    player.sendMessage(Common.message("tradeOther", { name: target.getUsername(), pronoun }));
    event.handled = true;
  }
}

module.exports = function attach(api) {
  api.onTradeRequest(tradeRequest);
};
