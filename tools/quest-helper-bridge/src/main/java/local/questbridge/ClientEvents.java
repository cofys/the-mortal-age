package local.questbridge;

import com.google.gson.*;
import net.runelite.api.*;
import net.runelite.api.events.*;

/** Ordered source callback DTOs become the actual upstream event classes. */
final class ClientEvents {
  static Object convert(SnapshotClient snapshot, JsonObject e) {
    String type = e.get("type").getAsString();
    return switch (type) {
      case "gameTick" -> new GameTick();
      case "varbitChanged" -> {
        VarbitChanged v = new VarbitChanged();
        v.setVarpId(e.has("varpId") ? e.get("varpId").getAsInt() : -1);
        v.setVarbitId(e.has("varbitId") ? e.get("varbitId").getAsInt() : -1);
        if (e.has("value")) v.setValue(e.get("value").getAsInt());
        yield v;
      }
      case "widgetLoaded" -> {
        WidgetLoaded w = new WidgetLoaded();
        w.setGroupId(e.get("groupId").getAsInt());
        yield w;
      }
      case "widgetClosed" ->
          new WidgetClosed(
              e.get("groupId").getAsInt(),
              e.has("modalMode") ? e.get("modalMode").getAsInt() : 0,
              !e.has("unload") || e.get("unload").getAsBoolean());
      case "chatMessage" -> {
        ChatMessageType t =
            e.has("typeId")
                ? ChatMessageType.of(e.get("typeId").getAsInt())
                : e.has("chatType")
                    ? ChatMessageType.valueOf(e.get("chatType").getAsString())
                    : ChatMessageType.GAMEMESSAGE;
        yield new ChatMessage(
            null,
            t,
            string(e, "name"),
            e.get("message").getAsString(),
            string(e, "sender"),
            e.has("timestamp") ? e.get("timestamp").getAsInt() : 0);
      }
      case "npcSpawned" -> new NpcSpawned(snapshot.npcForEvent(e));
      case "npcDespawned" -> new NpcDespawned(snapshot.npcForEvent(e));
      case "npcChanged" -> {
        NPC npc = snapshot.npcForEvent(e);
        if (!e.has("oldId"))
          throw new BridgeFailure(
              "MISSING_STATE", "npcChanged.oldId", "NPC composition event requires oldId");
        int id = e.get("oldId").getAsInt();
        NPCComposition old =
            SnapshotClient.strict(
                NPCComposition.class,
                i ->
                    switch (i.getMethod().getName()) {
                      case "getId" -> id;
                      default -> SnapshotClient.fail(i);
                    });
        yield new NpcChanged(npc, old);
      }
      case "animationChanged" -> {
        AnimationChanged a = new AnimationChanged();
        a.setActor(snapshot.npcForEvent(e));
        yield a;
      }
      case "interactingChanged" -> {
        NPC npc = snapshot.npcForEvent(e);
        yield new InteractingChanged(npc, npc.getInteracting());
      }
      case "overheadTextChanged" ->
          new OverheadTextChanged(snapshot.npcForEvent(e), string(e, "text"));
      case "itemContainerChanged" -> {
        int id = e.get("containerId").getAsInt();
        yield new ItemContainerChanged(id, snapshot.container(id));
      }
      case "itemSpawned", "itemDespawned", "itemQuantityChanged" -> {
        JsonObject item = e.getAsJsonObject("item");
        Tile tile = snapshot.tile(item);
        TileItem view =
            SnapshotClient.strict(
                TileItem.class,
                i ->
                    switch (i.getMethod().getName()) {
                      case "getId" -> item.get("id").getAsInt();
                      case "getQuantity" -> item.get("quantity").getAsInt();
                      default -> SnapshotClient.fail(i);
                    });
        if (type.equals("itemSpawned")) yield new ItemSpawned(tile, view);
        if (type.equals("itemDespawned")) yield new ItemDespawned(tile, view);
        if (!e.has("oldQuantity"))
          throw new BridgeFailure(
              "MISSING_STATE",
              "itemQuantityChanged.oldQuantity",
              "Quantity change event requires oldQuantity");
        yield new ItemQuantityChanged(
            view, tile, e.get("oldQuantity").getAsInt(), item.get("quantity").getAsInt());
      }
      case "gameStateChanged" -> {
        GameStateChanged g = new GameStateChanged();
        g.setGameState(GameState.valueOf(e.get("gameState").getAsString()));
        yield g;
      }
      default -> throw BridgeFailure.unsupported("event " + type);
    };
  }

  static String string(JsonObject e, String key) {
    return e.has(key) && !e.get(key).isJsonNull() ? e.get(key).getAsString() : "";
  }
}
