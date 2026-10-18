"use strict";

/**
 * The lab state survives logouts, and every varbit it holds is re-sent at login (rsprox
 * captures: the order, introduction and resin vars arrive with the login burst, inside the lab
 * or anywhere else). A player who has never been given orders gets their first three here.
 */

const Shared = require("./Shared.Mixology");
const Orders = require("./Orders.Mixology");

function syncOnLogin({ player }) {
  Orders.ensureOrders(player);
  Shared.sync(player);
}

module.exports = function attachState(api) {
  api.persistAttribute(Shared.STATE_ATTRIBUTE, { vars: {} });
  api.persistAttribute(Shared.RESIN_ATTRIBUTE, { mox: 0, aga: 0, lye: 0 });
  api.persistAttribute(Shared.ORDERS_ATTRIBUTE, 0);
  api.onPlayerLogin(syncOnLogin);
};
