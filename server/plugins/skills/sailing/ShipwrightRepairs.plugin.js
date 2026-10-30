const repairs = require('./shipwrightrepairs/Repair.ShipwrightRepairs');
module.exports = {
  name: 'SailingShipwrightRepairs',
  members: true,
  register(api) {
    repairs.attach(api);
  },
};
