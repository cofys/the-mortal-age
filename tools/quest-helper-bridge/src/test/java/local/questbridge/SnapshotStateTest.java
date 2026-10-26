package local.questbridge;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.*;
import java.nio.*;
import java.util.Base64;
import net.runelite.api.*;
import org.junit.jupiter.api.Test;

class SnapshotStateTest {
  @Test
  void packedHeightsPreserveAxisOrderAndMultiplier() {
    var state = BridgeTest.snapshot();
    byte[] values = new byte[4 * 105 * 105 * 2];
    ByteBuffer.wrap(values)
        .order(ByteOrder.LITTLE_ENDIAN)
        .putShort(((2 * 105 + 12) * 105 + 13) * 2, (short) 30);
    JsonObject packed = new JsonObject();
    packed.addProperty("encoding", "int16-le-base64");
    packed.add("shape", JsonParser.parseString("[4,105,105]"));
    packed.addProperty("multiplier", -8);
    packed.addProperty("data", Base64.getEncoder().encodeToString(values));
    JsonObject g = new JsonObject();
    g.add("tileHeightsPacked", packed);
    state.add("geometry", g);
    var snapshot = new SnapshotClient(state);
    assertEquals(-240, snapshot.client.getTopLevelWorldView().getTileHeights()[2][12][13]);
  }

  @Test
  void sceneSnapshotContainsObjectsAndGroundItems() {
    var state = BridgeTest.snapshot();
    state.add(
        "objects",
        JsonParser.parseString(
            "[{\"id\":100,\"x\":3206,\"y\":3214,\"plane\":0,\"type\":\"game\"}]"));
    state.add(
        "groundItems",
        JsonParser.parseString("[{\"id\":1944,\"quantity\":2,\"x\":3206,\"y\":3214,\"plane\":0}]"));
    var snapshot = new SnapshotClient(state);
    Tile t = snapshot.client.getScene().getTiles()[0][54][62];
    assertEquals(100, t.getGameObjects()[0].getId());
    assertEquals(2, t.getGroundItems().get(0).getQuantity());
  }

  @Test
  void projectionUsesExactBrowserMatrix() {
    var state = BridgeTest.snapshot();
    state.add(
        "geometry",
        JsonParser.parseString(
            "{\"width\":800,\"height\":600,\"viewProjectionMatrix\":[0.001,0,0,0,0,1,0,0,0,0.001,1,0,-3.152,-3.152,0,1]}"));
    var snapshot = new SnapshotClient(state);
    try (var scope = new SnapshotProjection(snapshot)) {
      Point p = Perspective.localToCanvas(snapshot.client, 64, 64, 0);
      assertEquals(new Point(400, 300), p);
      assertEquals(new Point(400, 600), Perspective.localToCanvas(snapshot.client, 0, 0, -128));
    }
  }

  @Test
  void sceneChangesCreateOrderedDespawnAndSpawnEvents() {
    var state = BridgeTest.snapshot();
    state.add(
        "objects",
        JsonParser.parseString(
            "[{\"id\":100,\"x\":3206,\"y\":3214,\"plane\":0,\"type\":\"game\"}]"));
    var snapshot = new SnapshotClient(state);
    var originalObject = snapshot.client.getScene().getTiles()[0][54][62].getGameObjects()[0];
    snapshot.update(state.deepCopy());
    assertSame(
        originalObject, snapshot.client.getScene().getTiles()[0][54][62].getGameObjects()[0]);
    snapshot.deltaEvents.clear();
    var next = state.deepCopy();
    next.add(
        "objects",
        JsonParser.parseString(
            "[{\"id\":101,\"x\":3206,\"y\":3214,\"plane\":0,\"type\":\"game\"}]"));
    snapshot.update(next);
    assertEquals(2, snapshot.deltaEvents.size());
    assertInstanceOf(
        net.runelite.api.events.GameObjectDespawned.class, snapshot.deltaEvents.get(0));
    assertSame(
        originalObject,
        ((net.runelite.api.events.GameObjectDespawned) snapshot.deltaEvents.get(0))
            .getGameObject());
    assertInstanceOf(net.runelite.api.events.GameObjectSpawned.class, snapshot.deltaEvents.get(1));
  }

  @Test
  void despawnFallbackUsesEcsIdentityWithoutConfusingServerIndices() {
    var state = BridgeTest.snapshot();
    state.add(
        "npcs",
        JsonParser.parseString(
            "[{\"index\":50,\"ecsIndex\":7,\"id\":2813,\"name\":\"Shopkeeper\",\"x\":3212,\"y\":3246,\"plane\":0}]"));
    var snapshot = new SnapshotClient(state);
    NPC original = snapshot.client.getNpcs().get(0);
    var next = state.deepCopy();
    next.add("npcs", new JsonArray());
    snapshot.update(next);
    var event =
        JsonParser.parseString("{\"type\":\"npcDespawned\",\"ecsIndex\":7}").getAsJsonObject();
    var converted = (net.runelite.api.events.NpcDespawned) ClientEvents.convert(snapshot, event);
    assertSame(original, converted.getNpc());
    assertEquals(2813, converted.getNpc().getId());
  }

  @Test
  void packedStaticWidgetChildrenAreIndexedBeforeAnyParentLookup() {
    var state = BridgeTest.snapshot();
    state.add(
        "widgets",
        JsonParser.parseString(
            "[{\"id\":100,\"staticChildren\":[{\"id\":200,\"text\":\"riddle\"}],\"dynamicChildren\":[],\"nestedChildren\":[]}]"));
    var snapshot = new SnapshotClient(state);
    assertNotNull(snapshot.client.getWidget(200));
    assertEquals("riddle", snapshot.client.getWidget(200).getText());
  }

  @Test
  void preservesContainerSlotIndicesAcrossInventoryEquipmentAndBank() {
    var state = BridgeTest.snapshot();
    state.add("inventory", JsonParser.parseString("[{\"id\":1944,\"quantity\":1,\"slot\":20}]"));
    state.add("equipment", JsonParser.parseString("[{\"id\":4151,\"quantity\":1,\"slot\":3}]"));
    state.add("bank", JsonParser.parseString("[{\"id\":995,\"quantity\":500,\"slot\":40}]"));
    var snapshot = new SnapshotClient(state);
    assertEquals(1944, snapshot.client.getItemContainer(93).getItem(20).getId());
    assertEquals(4151, snapshot.client.getItemContainer(94).getItem(3).getId());
    assertEquals(995, snapshot.client.getItemContainer(95).getItem(40).getId());
    assertEquals(-1, snapshot.client.getItemContainer(94).getItems()[0].getId());
    assertEquals(28, snapshot.client.getItemContainer(93).getItems().length);
    assertEquals(14, snapshot.client.getItemContainer(94).getItems().length);
    assertEquals(1, snapshot.client.getItemContainer(95).count());
    assertEquals(500, snapshot.client.getItemContainer(95).count(995));
    assertNull(snapshot.client.getItemContainer(94).getItem(0));
  }

  @Test
  void hintArrowRequiresExplicitObservedState() {
    var state = BridgeTest.snapshot();
    state.remove("hintArrowNpcIndex");
    var snapshot = new SnapshotClient(state);
    assertEquals(
        "MISSING_STATE",
        assertThrows(BridgeFailure.class, () -> snapshot.client.getHintArrowNpc()).code);
    state.addProperty("hintArrowNpcIndex", -1);
    snapshot.update(state);
    assertNull(snapshot.client.getHintArrowNpc());
  }
}
