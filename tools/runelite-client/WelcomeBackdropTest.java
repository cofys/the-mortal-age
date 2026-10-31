import java.awt.*;
import java.awt.image.BufferedImage;
import java.lang.reflect.*;
import net.runelite.api.*;
import net.runelite.api.events.BeforeRender;

/** Real retained raster through the actual pre-render callback; native ordering is checked in RuneLite. */
public final class WelcomeBackdropTest {
    static int root=378,width=765,height=503;
    static GameState state=GameState.LOGGED_IN;
    static BufferedImage image=scene();
    static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    static BufferedImage scene(){BufferedImage b=new BufferedImage(1000,800,BufferedImage.TYPE_INT_ARGB);Graphics2D g=b.createGraphics();g.setColor(Color.BLUE);g.fillRect(0,0,1000,800);g.dispose();return b;}
    public static void main(String[] args)throws Exception {
        MainBufferProvider provider=(MainBufferProvider)Proxy.newProxyInstance(MainBufferProvider.class.getClassLoader(),new Class[]{MainBufferProvider.class},(p,m,a)->{
            if(m.getName().equals("getImage"))return image;throw new AssertionError("Unexpected buffer API: "+m.getName());
        });
        Client client=(Client)Proxy.newProxyInstance(Client.class.getClassLoader(),new Class[]{Client.class},(p,m,a)->switch(m.getName()){
            case "getTopLevelInterfaceId" -> root;
            case "getGameState" -> state;
            case "getCanvasWidth" -> width;
            case "getCanvasHeight" -> height;
            case "getBufferProvider" -> provider;
            default -> throw new AssertionError("Unexpected client API: "+m.getName());
        });
        WelcomeBackdrop backdrop=new WelcomeBackdrop();Field field=WelcomeBackdrop.class.getDeclaredField("client");field.setAccessible(true);field.set(backdrop,client);
        backdrop.onBeforeRender(new BeforeRender());
        check(image.getRGB(0,0)==Color.BLACK.getRGB()&&image.getRGB(764,502)==Color.BLACK.getRGB(),"Welcome clears old scene before native controls");
        check(image.getRGB(900,700)==Color.BLUE.getRGB(),"Never clear outside the game canvas");
        Graphics2D g=image.createGraphics();g.setColor(Color.WHITE);g.fillRect(100,100,40,20);g.dispose();backdrop.onBeforeRender(new BeforeRender());
        check(image.getRGB(100,100)==Color.WHITE.getRGB(),"Steady frames preserve cached native controls");
        root=161;image=scene();backdrop.onBeforeRender(new BeforeRender());check(image.getRGB(20,20)==Color.BLUE.getRGB(),"Play shows gameplay");
        root=378;state=GameState.LOGIN_SCREEN;backdrop.onBeforeRender(new BeforeRender());check(image.getRGB(20,20)==Color.BLUE.getRGB(),"Never cover login artwork");
        state=GameState.LOGGED_IN;backdrop.onBeforeRender(new BeforeRender());check(image.getRGB(20,20)==Color.BLACK.getRGB(),"Welcome re-entry clears retained gameplay");
        width=950;height=700;backdrop.onBeforeRender(new BeforeRender());check(image.getRGB(949,699)==Color.BLACK.getRGB()&&image.getRGB(950,700)==Color.BLUE.getRGB(),"Resize covers current bounds only");
        image=scene();backdrop.onBeforeRender(new BeforeRender());check(image.getRGB(949,699)==Color.BLACK.getRGB(),"Replacement provider image is cleared");
        System.out.println("WelcomeBackdropTest: 8 checks passed (real retained raster and pre-render callback)");
    }
}
