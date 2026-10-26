package local.questbridge;

import com.google.gson.*;
import net.runelite.api.*;
import net.runelite.api.coords.LocalPoint;
import org.mockito.*;

/** Exact browser camera projection. Only the public projection entry points are adapted. */
final class SnapshotProjection implements AutoCloseable {
  private final MockedStatic<Perspective> scope;

  SnapshotProjection(SnapshotClient snapshot) {
    scope =
        Mockito.mockStatic(
            Perspective.class,
            i -> {
              if (!i.getMethod().getName().equals("localToCanvas")) return i.callRealMethod();
              Object[] a = i.getArguments();
              if (a.length >= 3 && a[1] instanceof LocalPoint local) {
                int plane = ((Number) a[2]).intValue();
                int height =
                    Perspective.getTileHeight(snapshot.client, local, plane)
                        - (a.length > 3 ? ((Number) a[3]).intValue() : 0);
                return project(snapshot, local.getX(), local.getY(), height);
              }
              if (a.length == 4)
                return project(
                    snapshot,
                    ((Number) a[1]).intValue(),
                    ((Number) a[2]).intValue(),
                    ((Number) a[3]).intValue());
              if (a.length == 5) {
                int world = ((Number) a[1]).intValue();
                if (world != 0 && world != -1)
                  throw BridgeFailure.unsupported("Perspective.localToCanvas subworld " + world);
                return project(
                    snapshot,
                    ((Number) a[2]).intValue(),
                    ((Number) a[3]).intValue(),
                    ((Number) a[4]).intValue());
              }
              throw BridgeFailure.unsupported(
                  "Perspective.localToCanvas signature " + i.getMethod());
            });
  }

  static Point project(SnapshotClient snapshot, double x, double y, double height) {
    if (!snapshot.state.has("geometry")
        || !snapshot.state.getAsJsonObject("geometry").has("viewProjectionMatrix"))
      throw BridgeFailure.missing("geometry", 0);
    JsonObject g = snapshot.state.getAsJsonObject("geometry");
    double[] matrix = new Gson().fromJson(g.get("viewProjectionMatrix"), double[].class);
    if (matrix.length != 16)
      throw new BridgeFailure("INVALID_STATE", "projection", "Expected16 camera matrix values");
    double wx = x / 128.0 + snapshot.number("baseX"),
        wy = height / 128.0,
        wz = y / 128.0 + snapshot.number("baseY");
    double cx = matrix[0] * wx + matrix[4] * wy + matrix[8] * wz + matrix[12],
        cy = matrix[1] * wx + matrix[5] * wy + matrix[9] * wz + matrix[13],
        cw = matrix[3] * wx + matrix[7] * wy + matrix[11] * wz + matrix[15];
    if (cw <= 0.1) return null;
    int width = g.get("width").getAsInt(), h = g.get("height").getAsInt();
    return new Point(
        (int) Math.round((cx / cw + 1) * 0.5 * width), (int) Math.round((1 - cy / cw) * 0.5 * h));
  }

  @Override
  public void close() {
    scope.close();
  }
}
