const Common = require('./whisperer/Common.Whisperer');
const Site = require('./whisperer/Site.Whisperer');
const Fight = require('./whisperer/Fight.Whisperer');
module.exports = { name: 'The Whisperer', members: true, register(api) { Common.init(api); Site.attach(api); Fight.attach(api); } };
