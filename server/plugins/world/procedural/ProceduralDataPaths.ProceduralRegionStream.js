const path = require("path");

const PROCEDURAL_DATA_DIRECTORY = path.join(__dirname, "..", "data");
const HOUSE_DUMP_DIRECTORY = path.join(PROCEDURAL_DATA_DIRECTORY, "house-examples");
const PRESET_OUTPUT_PATH = path.join(PROCEDURAL_DATA_DIRECTORY, "proc-building-presets.json");
const ANALYSIS_REPORT_DIRECTORY = path.join(PROCEDURAL_DATA_DIRECTORY, "analysis-reports");

module.exports = {
  PROCEDURAL_DATA_DIRECTORY,
  HOUSE_DUMP_DIRECTORY,
  PRESET_OUTPUT_PATH,
  ANALYSIS_REPORT_DIRECTORY,
};

