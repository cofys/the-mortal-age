package local.questbridge;

import com.google.gson.Gson;
import com.questhelper.*;
import com.questhelper.tools.VisibilityHelper;
import java.awt.image.BufferedImage;
import java.lang.reflect.*;
import java.util.*;
import java.util.function.BooleanSupplier;
import net.runelite.client.eventbus.EventBus;
import org.mockito.invocation.InvocationOnMock;

/** Explicit headless presentation services; all unlisted operations fail. */
final class HeadlessServices {
  final SnapshotClient snapshot;
  final EventBus bus;
  final List<Throwable> eventErrors = new ArrayList<>();
  final QuestHelperConfig config =
      new QuestHelperConfig() {
        public boolean showWorldMapPoint() {
          return false;
        }

        public boolean showTextHighlight() {
          return false;
        }

        public boolean showSymbolOverlay() {
          return false;
        }

        public boolean showMiniMapArrow() {
          return false;
        }

        public NpcHighlightStyle highlightStyleNpcs() {
          return NpcHighlightStyle.NONE;
        }

        public ObjectHighlightStyle highlightStyleObjects() {
          return ObjectHighlightStyle.NONE;
        }

        public GroundItemHighlightStyle highlightStyleGroundItems() {
          return GroundItemHighlightStyle.NONE;
        }

        public InventoryItemHighlightStyle highlightStyleInventoryItems() {
          return InventoryItemHighlightStyle.NONE;
        }

        // DetailedQuestStep posts PluginMessage("shortestpath", ...) when this is on; the
        // bridge hands those messages to the client's Shortest Path plugin.
        public boolean useShortestPath() {
          return flag("useShortestPath", QuestHelperConfig.super.useShortestPath());
        }

        // Sidebar and hint settings the browser client forwards with each evaluation.
        public boolean solvePuzzles() {
          return flag("solvePuzzles", QuestHelperConfig.super.solvePuzzles());
        }

        public boolean showWidgetHints() {
          return flag("showWidgetHints", QuestHelperConfig.super.showWidgetHints());
        }

        public boolean showWorldLines() {
          return flag("showWorldLines", QuestHelperConfig.super.showWorldLines());
        }

        public boolean stewBoosts() {
          return flag("stewBoostsPanel", QuestHelperConfig.super.stewBoosts());
        }

        public boolean showFullRequirements() {
          return flag("showFullRequirements", QuestHelperConfig.super.showFullRequirements());
        }

        public java.awt.Color passColour() {
          return colour("passColour", QuestHelperConfig.super.passColour());
        }

        public java.awt.Color failColour() {
          return colour("failColour", QuestHelperConfig.super.failColour());
        }

        public java.awt.Color partialSuccessColour() {
          return colour("partialSuccessColour", QuestHelperConfig.super.partialSuccessColour());
        }

        public java.awt.Color boostColour() {
          return colour("boostColour", QuestHelperConfig.super.boostColour());
        }

        public java.awt.Color targetOverlayColor() {
          return colour("targetOverlayColor", QuestHelperConfig.super.targetOverlayColor());
        }

        public java.awt.Color textHighlightColor() {
          return colour("textHighlightColor", QuestHelperConfig.super.textHighlightColor());
        }
      };

  /** Client settings by upstream key; booleans and 0xAARRGGBB numbers only. */
  final Map<String, Object> clientConfig = new HashMap<>();

  boolean flag(String key, boolean fallback) {
    return clientConfig.get(key) instanceof Boolean b ? b : fallback;
  }

  java.awt.Color colour(String key, java.awt.Color fallback) {
    return clientConfig.get(key) instanceof Number n ? new java.awt.Color(n.intValue(), true) : fallback;
  }

  void applyClientConfig(com.google.gson.JsonObject config) {
    clientConfig.clear();
    if (config == null) return;
    for (var e : config.entrySet()) {
      if (!e.getValue().isJsonPrimitive()) continue;
      var v = e.getValue().getAsJsonPrimitive();
      if (v.isBoolean()) clientConfig.put(e.getKey(), v.getAsBoolean());
      else if (v.isNumber()) clientConfig.put(e.getKey(), v.getAsLong());
    }
  }
  final Map<Class<?>, Object> services = new HashMap<>();
  /** The session's helper: QuestHelperPlugin.getSelectedQuest (the bank tag service reads it). */
  com.questhelper.questhelpers.QuestHelper selectedQuest;
  /** Upstream's "shortestpath" PluginMessages since the last evaluation, in order. */
  final List<net.runelite.client.events.PluginMessage> pluginMessages = new ArrayList<>();
  final Map<String, Object> configuration = new HashMap<>();
  final Deque<Runnable> callbacks = new ArrayDeque<>();

  HeadlessServices(SnapshotClient snapshot) {
    this.snapshot = snapshot;
    bus = new EventBus(eventErrors::add);
    services.put(net.runelite.api.Client.class, snapshot.client);
    services.put(EventBus.class, bus);
    bus.register(
        net.runelite.client.events.PluginMessage.class,
        message -> {
          if ("shortestpath".equals(message.getNamespace())) pluginMessages.add(message);
        },
        0);
    services.put(Gson.class, new Gson());
    services.put(QuestHelperConfig.class, config);
    // Native providers own standard model outlines. In disabled headless outline rendering,
    // serialized objects remain eligible without loading JVM models solely for occlusion.
    services.put(
        VisibilityHelper.class,
        new VisibilityHelper() {
          @Override
          public boolean isObjectVisible(net.runelite.api.TileObject object) {
            return true;
          }
        });
  }

  Object service(Class<?> type) {
    if (services.containsKey(type)) return services.get(type);
    String n = type.getSimpleName();
    if (!Set.of(
            "Injector",
            "QuestHelperPlugin",
            "ClientThread",
            "ItemManager",
            "SpriteManager",
            "ModelOutlineRenderer",
            "TooltipManager",
            "WorldMapPointManager",
            "RuneliteObjectManager",
            "ConfigManager",
            "PlayerStateManager")
        .contains(n)) throw BridgeFailure.unsupported("inject " + type.getName());
    Object value = SnapshotClient.strict(type, i -> invokeService(n, i));
    services.put(type, value);
    return value;
  }

  Object invokeService(String type, InvocationOnMock i) throws Throwable {
    String m = i.getMethod().getName();
    Object[] a = i.getArguments();
    switch (type + "." + m) {
      case "Injector.injectMembers":
        inject(a[0]);
        return null;
      case "ClientThread.invokeLater":
      case "ClientThread.invoke":
      case "ClientThread.invokeAtTickEnd":
        Object task = a[0];
        callbacks.add(
            () -> {
              if (task instanceof Runnable r) r.run();
              else if (task instanceof BooleanSupplier s) s.getAsBoolean();
              else throw BridgeFailure.unsupported("ClientThread task " + task.getClass());
            });
        return null;
      case "QuestHelperPlugin.getPlayerStateManager":
        return service(com.questhelper.statemanagement.PlayerStateManager.class);
      case "PlayerStateManager.getPlayerName":
        return snapshot.client.getLocalPlayer().getName();
      case "PlayerStateManager.getAccountType":
        return com.questhelper.domain.AccountType.get(
            snapshot.varbit(net.runelite.api.gameval.VarbitID.IRONMAN));
      case "ConfigManager.getRSProfileKey":
        return snapshot.client.getLocalPlayer().getName();
      case "QuestHelperPlugin.getClientThread":
        return service(net.runelite.client.callback.ClientThread.class);
      case "QuestHelperPlugin.loadSidebarOrder":
        return new ArrayList<Integer>();
      case "QuestHelperPlugin.getConfig":
        return config;
      case "QuestHelperPlugin.isBankTabOpen":
        return snapshot.client.getWidget(net.runelite.api.gameval.InterfaceID.Bankmain.ITEMS)
            != null;
      case "QuestHelperPlugin.isDeveloperMode":
        return false;
      case "QuestHelperPlugin.getClient":
        return snapshot.client;
      case "QuestHelperPlugin.getSelectedQuest":
        return selectedQuest;
      case "SpriteManager.getSprite":
        return new BufferedImage(32, 32, BufferedImage.TYPE_INT_ARGB);
      case "ItemManager.getImage":
        return new net.runelite.client.util.AsyncBufferedImage(
            (net.runelite.client.callback.ClientThread)
                service(net.runelite.client.callback.ClientThread.class),
            32,
            32,
            BufferedImage.TYPE_INT_ARGB);
      case "ItemManager.getItemComposition":
        return snapshot.client.getItemDefinition(((Number) a[0]).intValue());
      case "ItemManager.canonicalize":
        return ((Number) a[0]).intValue();
      case "WorldMapPointManager.add":
      case "WorldMapPointManager.remove":
      case "WorldMapPointManager.removeIf":
      case "RuneliteObjectManager.removeGroupAndSubgroups":
      case "TooltipManager.add":
      case "TooltipManager.clear":
        return null;
      case "ConfigManager.getConfiguration":
      case "ConfigManager.getRSProfileConfiguration":
        {
          String key = a[0] + "/" + a[1];
          Object v = configuration.get(key);
          if (a.length > 2 && v != null) return new Gson().fromJson(v.toString(), (Class<?>) a[2]);
          return v == null ? null : v.toString();
        }
      case "ConfigManager.setConfiguration":
      case "ConfigManager.setRSProfileConfiguration":
        configuration.put(a[0] + "/" + a[1], a[2]);
        return null;
      case "ConfigManager.unsetConfiguration":
      case "ConfigManager.unsetRSProfileConfiguration":
        configuration.remove(a[0] + "/" + a[1]);
        return null;
      default:
        throw BridgeFailure.unsupported(type + "." + m);
    }
  }

  void inject(Object target) {
    for (Class<?> type = target.getClass(); type != null; type = type.getSuperclass())
      for (Field field : type.getDeclaredFields()) {
        if (Arrays.stream(field.getAnnotations())
            .noneMatch(a -> a.annotationType().getSimpleName().equals("Inject"))) continue;
        try {
          field.setAccessible(true);
          field.set(target, service(field.getType()));
        } catch (IllegalAccessException e) {
          throw new IllegalStateException(e);
        }
      }
  }

  void flush() {
    int count = 0;
    try {
      while (!callbacks.isEmpty()) {
        if (++count > 10000) throw BridgeFailure.unsupported("ClientThread runaway callbacks");
        callbacks.removeFirst().run();
      }
    } catch (RuntimeException error) {
      callbacks.clear();
      eventErrors.add(error);
    }
    if (!eventErrors.isEmpty()) {
      // EventBus catches failures per subscriber, so a scene refresh can enqueue
      // hundreds of identical missing-definition failures from one snapshot.
      // Consume that entire batch; none describes a later hydrated snapshot.
      // A fatal/unknown API failure must not be hidden behind a missing cache.
      Throwable t = eventErrors.getFirst();
      for (Throwable error : eventErrors)
        if (!(error instanceof BridgeFailure failure) || !failure.code.equals("MISSING_STATE")) {
          t = error;
          break;
        }
      eventErrors.clear();
      if (t instanceof RuntimeException r) throw r;
      throw new RuntimeException(t);
    }
  }
}
