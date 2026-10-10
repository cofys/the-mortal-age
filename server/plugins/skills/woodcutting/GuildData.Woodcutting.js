/** plugins/skills/data/woodcutting-guild.json, read once through api.core's definitions path. */
const fs = require("fs");
const path = require("path");

let data = null;

function load(core) {
  if (!data) {
    data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "woodcutting-guild.json"), "utf8"));
  }
  return data;
}

module.exports = { load };
