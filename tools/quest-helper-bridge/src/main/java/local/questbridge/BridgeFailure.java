package local.questbridge;

import com.google.gson.JsonObject;

public final class BridgeFailure extends RuntimeException {
  public final String code, method;
  public final JsonObject request;
  public final com.google.gson.JsonArray requests = new com.google.gson.JsonArray();

  BridgeFailure(String code, String method, String message) {
    this(code, method, message, null);
  }

  BridgeFailure(String code, String method, String message, JsonObject request) {
    super(message);
    this.code = code;
    this.method = method;
    this.request = request;
  }

  static BridgeFailure unsupported(String method) {
    return new BridgeFailure("UNSUPPORTED_API", method, "No snapshot-backed adapter for " + method);
  }

  static BridgeFailure missing(String kind, int id) {
    JsonObject req = new JsonObject();
    req.addProperty("kind", kind);
    req.addProperty("id", id);
    return new BridgeFailure("MISSING_STATE", kind, "Snapshot requires " + kind + " " + id, req);
  }

  static BridgeFailure missingMany(String kind, java.util.Collection<Integer> ids) {
    BridgeFailure failure =
        new BridgeFailure(
            "MISSING_STATE", kind, "Snapshot requires " + ids.size() + " known cache definitions");
    for (int id : ids) {
      JsonObject req = new JsonObject();
      req.addProperty("kind", kind);
      req.addProperty("id", id);
      failure.requests.add(req);
    }
    return failure;
  }

  JsonObject diagnostic() {
    JsonObject d = new JsonObject();
    d.addProperty("code", code);
    d.addProperty("method", method);
    d.addProperty("message", getMessage());
    return d;
  }
}
