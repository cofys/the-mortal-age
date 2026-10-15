"use strict";

let activeRuntime = null;
let activeBehaviorMode = null;

function setActiveBotRuntime(runtime, behaviorMode) {
  activeRuntime = runtime ?? null;
  activeBehaviorMode = behaviorMode ?? null;
}

function getActiveBotRuntime() {
  return {
    runtime: activeRuntime,
    behaviorMode: activeBehaviorMode,
  };
}

module.exports = {
  setActiveBotRuntime,
  getActiveBotRuntime,
};
