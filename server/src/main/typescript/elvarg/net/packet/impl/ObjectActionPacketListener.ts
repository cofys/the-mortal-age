import { ObjectDefinition } from "../../../game/definition/ObjectDefinition";
import { MapObjects } from "../../../game/entity/impl/object/MapObjects";
import { Player } from "../../../game/entity/impl/player/Player";
import { Location } from "../../../game/model/Location";
import { PluginManager } from "../../../plugins/PluginManager";
import { BoatManager } from "../../../game/content/sailing/BoatManager";

/**
 * How far from the tile under a player on a boat deck a main-world loc can be used. A dock's
 * gangplank was used from 9 tiles away in a live capture (Port Sarim).
 */
const DECK_REACH_TILES = 12;

export class ObjectActionPacketListener {
  public executeAction(
    player: Player,
    id: number,
    x: number,
    y: number,
    clickType = 0,
    action?: string
  ): void {
    if (!player || player.getHitpoints() <= 0 || player.busy()) {
      return;
    }
    const objectLocation = new Location(
      x,
      y,
      player.getLocation().getZ()
    );
    const object = MapObjects.getPrivateArea(player, id, objectLocation);
    if (!object) {
      return;
    }
    const definition = ObjectDefinition.forPlayer(object.getId(), player);
    if (!definition) return;
    if (!Number.isInteger(clickType) || clickType < 1 || clickType > 5) {
      const normalized = action?.trim().toLowerCase();
      clickType = normalized
        ? (definition?.getInteractions()?.findIndex((option) => option?.toLowerCase() === normalized) ?? -1) + 1
        : 0;
    }
    if (clickType < 1 || clickType > 5) return;

    const option = definition?.getInteractions()?.[clickType - 1]?.toLowerCase();
    const executeInteraction = () => {
      // Another player may have opened, emptied or replaced it on the way: nothing happens.
      if (!MapObjects.stillStands(player, id, objectLocation, object)) return;
      const interactionLocation = player.getLocation().clone();
      player.getMovementQueue().reset();
      player.getMovementQueue().walkToReset();
      player.setPositionToFace(object.getLocation());

      const pluginHandled = PluginManager.emitObjectInteraction({
        player,
        object,
        definition,
        objectId: object.getId(),
        clickType,
        option,
        location: {
          x: object.getLocation().getX(),
          y: object.getLocation().getY(),
          z: object.getLocation().getZ(),
        },
        sourceLocation: {
          x: interactionLocation.getX(),
          y: interactionLocation.getY(),
          z: interactionLocation.getZ(),
        },
        handled: false,
      });
      if (pluginHandled) {
        return;
      }

      if (option === "bank") {
        player.getBank(player.getCurrentBankTab()).open();
        return;
      }

    };

    // From a boat deck there is no path across the water: main-world locs (a dock's
    // gangplank) are used from the deck when close to the tile under the player.
    if (player.getPrivateArea()?.countsAsMainWorld() && object.getPrivateArea() == null) {
      const source = player.getLocation();
      // Route hooks also release the helm, even when no land route can be built.
      PluginManager.emitObjectRoute({
        player, object, definition, objectId: object.getId(), clickType,
        sourceLocation: { x: source.getX(), y: source.getY(), z: source.getZ() },
        destination: null,
      });
      const root = BoatManager.rootLocation(player);
      const location = object.getLocation();
      if (Math.max(Math.abs(location.getX() - root.getX()), Math.abs(location.getY() - root.getY())) <= DECK_REACH_TILES) {
        executeInteraction();
      } else {
        player.sendMessage("You can't reach that.");
      }
      return;
    }

    player.getMovementQueue().walkToObject(object, {
      execute: executeInteraction,
    }, clickType);
  }
}
