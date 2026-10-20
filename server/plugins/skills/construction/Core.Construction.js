/**
 * Construction: the shared `api.core`, filled in by the plugin before the other construction
 * files load, plus the plugin's own `api`. The files destructure what they need from it at
 * load time.
 */
module.exports = {
  init(api) {
    Object.assign(module.exports, api.core, { api });
  },
};
