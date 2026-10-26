package local.questbridge;

import static org.junit.jupiter.api.Assertions.*;

import java.awt.*;
import org.junit.jupiter.api.Test;

class PortableGraphicsTest {
  @Test
  void capturesTransformedSolverShapesAndText() {
    var graphics = new PortableGraphics(800, 600);
    graphics.translate(10, 20);
    graphics.setColor(Color.RED);
    graphics.drawRect(1, 2, 30, 40);
    graphics.drawString("Solve", 5, 6);
    assertEquals(2, graphics.commands.size());
    assertEquals("path", graphics.commands.get(0).getAsJsonObject().get("kind").getAsString());
    assertEquals(
        11,
        graphics
            .commands
            .get(0)
            .getAsJsonObject()
            .getAsJsonArray("path")
            .get(0)
            .getAsJsonObject()
            .getAsJsonArray("values")
            .get(0)
            .getAsInt());
    assertEquals(15, graphics.commands.get(1).getAsJsonObject().get("x").getAsInt());
  }
}
