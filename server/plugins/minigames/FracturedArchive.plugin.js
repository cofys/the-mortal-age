"use strict";

/**
 * The Fractured Archive (Raids 4): the Chasm of Tears shortcut, the lobby (parties, the records,
 * the Ascension rocks) and the raid itself, so far its first room, the Archive Guardian. Each
 * unit lives in ./tfa/; add one line per unit. docs/fractured-archive.md.
 */
module.exports = {
  name: "FracturedArchive",
  members: true,
  register(api) {
    require("./tfa/Entry.FracturedArchive")(api);
    require("./tfa/Lobby.FracturedArchive")(api);
    require("./tfa/Gathering.FracturedArchive")(api);
    require("./tfa/Grouping.FracturedArchive")(api);
    require("./tfa/Records.FracturedArchive")(api);
    require("./tfa/Raid.FracturedArchive")(api);
    require("./tfa/Guardian.FracturedArchive")(api);
    require("./tfa/Commands.FracturedArchive")(api);
  },
};
