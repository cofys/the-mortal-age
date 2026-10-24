import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { CameraConfig } from "../game/plugins/camera/CameraConfig";
import { ControlsHelp } from "../game/controls/ControlsHelp";

const config = new ConfigManager(undefined);
const props = { configManager: config, closeCameraActive: true, onExitCloseCamera() {} };
assert.equal(renderToStaticMarkup(React.createElement(ControlsHelp, { ...props, closeCameraActive: false })), "");
let markup = renderToStaticMarkup(React.createElement(ControlsHelp, props));
assert.match(markup, /Controls/);
assert.match(markup, /Exit close camera/);
assert.match(markup, /aria-expanded="false"/);
assert.doesNotMatch(markup, /Close camera is active/);
config.setConfigValue(CameraConfig, "controlsExpanded", true);
markup = renderToStaticMarkup(React.createElement(ControlsHelp, props));
for (const text of [/aria-expanded="true"/, /Backquote/, /above Tab/, /WASD/, /Settings/]) assert.match(markup, text);
assert.equal(renderToStaticMarkup(React.createElement(ControlsHelp, { ...props, closeCameraActive: false })), "", "mode exit hides the expanded guide too");

console.log("contextual controls visibility and help passed");
