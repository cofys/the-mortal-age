"use strict";

/**
 * CitizenMonitor — attaches the read-only citizen movement monitor endpoint.
 *
 * GET /api/citizen-monitor -> JSON with positions, activities, last-move times.
 * No auth (read-only debug data, visible in-game anyway). Poll via SSH tunnel.
 */

const { attach } = require("./CitizenMonitorApi");

function attachPlugin(api) {
  attach(api);
}

module.exports = {
  name: "CitizenMonitor",
  register: attachPlugin,
};
