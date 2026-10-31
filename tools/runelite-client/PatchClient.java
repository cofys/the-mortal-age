import java.io.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.CertificateFactory;
import java.util.*;
import java.util.zip.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;
import net.rsprox.patch.PatchResult;
import net.rsprox.patch.runelite.RuneLitePatcher;
import com.google.gson.JsonParser;

/** Applies the public RSProx patcher without its proxy-only Unix socket handshake. */
public final class PatchClient {
    static final String INJECTED = "injected-client-1.13.3.jar";
    static final String CLIENT = "client-1.13.3.jar";
    public static void main(String[] args) throws Exception {
        Path runtime = Path.of(args[0]).toAbsolutePath();
        if (args[1].equals("verify")) {
            verify(runtime, args.length > 2 && args[2].equals("hd"));
            return;
        }
        int port = Integer.parseInt(args[2]), httpPort = Integer.parseInt(args[3]);
        String rsa = Files.readString(Path.of(args[4])).trim();
        if (port == 43594 || port < 1024 || port > 65535 || httpPort < 1024 || httpPort > 65535)
            throw new IllegalArgumentException("Use separate unprivileged gateway ports, never live43594");
        if (!rsa.matches("[a-fA-F0-9]{128,256}")) throw new IllegalArgumentException("Expected hexadecimal RSA modulus");
        Path out = Files.createDirectories(runtime.resolve("patched"));
        RuneLitePatcher patcher = new RuneLitePatcher();
        PatchResult result = patcher.patch(runtime.resolve("artifacts/" + INJECTED), rsa, port, -1);
        if (!(result instanceof PatchResult.Success success)) throw new IllegalStateException("Injected patch failed");
        normalize(success.getOutputPath(), out.resolve(INJECTED), httpPort);
        Path client = patcher.patchLocalHostSupport(runtime.resolve("artifacts/" + CLIENT), httpPort, "TSPS RuneLite 241", false);
        normalize(client, out.resolve(CLIENT), httpPort);
        validatePatched(out, rsa, port, httpPort);
        System.out.println("Prepared revision241 loopback client: game=" + port + " HTTP=" + httpPort);
    }

    static void verify(Path runtime, boolean hd) throws Exception {
        Path injected = runtime.resolve("artifacts/" + INJECTED);
        boolean revision = false, assignment = false, getter = false;
        try (ZipFile zip = new ZipFile(injected.toFile())) {
            // getRevision decodes xd.aq using this multiplier. Check its real assignment,
            // rather than inferring the protocol revision from the RuneLite version.
            for (var entries = zip.entries(); entries.hasMoreElements();) {
                var entry = entries.nextElement();
                if (!entry.getName().endsWith(".class")) continue;
                ClassNode c = new ClassNode();
                new ClassReader(zip.getInputStream(entry).readAllBytes()).accept(c, 0);
                for (MethodNode method : c.methods) for (AbstractInsnNode ins : method.instructions) {
                    if (c.name.equals("client") && ins instanceof MethodInsnNode call && call.owner.equals("to") && call.name.equals("ma")) {
                        AbstractInsnNode prev = previous(previous(previous(ins)));
                        if (prev instanceof IntInsnNode value && value.operand == 241) revision = true;
                    }
                    if (c.name.equals("client") && method.name.equals("getRevision") && ins instanceof LdcInsnNode ldc && Integer.valueOf(-1757890883).equals(ldc.cst)) getter = true;
                    if (c.name.equals("to") && method.name.equals("ma") && ins instanceof FieldInsnNode field && ins.getOpcode() == Opcodes.PUTSTATIC && field.owner.equals("xd") && field.name.equals("aq")) {
                        AbstractInsnNode constant = previous(previous(ins));
                        AbstractInsnNode parameter = previous(constant);
                        if (constant instanceof LdcInsnNode ldc && ldc.cst instanceof Integer factor && factor * -1757890883 == 1 && parameter instanceof VarInsnNode variable && variable.var == 3) assignment = true;
                    }
                }
            }
        }
        if (!revision || !assignment || !getter) throw new IllegalStateException("Could not establish injected-client revision241 assignment");
        if (hd) {
            try (ZipFile zip = new ZipFile(runtime.resolve("artifacts/" + CLIENT).toFile())) {
                var cert = CertificateFactory.getInstance("X.509").generateCertificate(zip.getInputStream(zip.getEntry("net/runelite/client/externalplugins/externalplugins.crt")));
                byte[] manifest = Files.readAllBytes(runtime.resolve("plugin-manifest.js"));
                var input = new DataInputStream(new ByteArrayInputStream(manifest));
                byte[] sig = input.readNBytes(input.readInt());
                Signature verifier = Signature.getInstance("SHA256withRSA");
                byte[] data = input.readAllBytes();
                verifier.initVerify(cert); verifier.update(data);
                if (!verifier.verify(sig)) throw new SecurityException("117HD manifest signature invalid");
                String expected = null;
                for (var item : new JsonParser().parse(new String(data, StandardCharsets.UTF_8)).getAsJsonObject().getAsJsonArray("jars")) {
                    var jar = item.getAsJsonObject();
                    if (jar.get("internalName").getAsString().equals("117hd")) expected = jar.get("jarHash").getAsString();
                }
                String actual = Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(runtime.resolve("117hd.jar"))));
                if (!actual.equals(expected)) throw new SecurityException("117HD jar differs from RuneLite-signed manifest");
            }
        }
        System.out.println("Verified injected revision241 field assignment" + (hd ? " and RuneLite-signed plugin manifest" : ""));
    }

    static AbstractInsnNode previous(AbstractInsnNode instruction) {
        do { instruction = instruction.getPrevious(); } while (instruction != null && instruction.getOpcode() < 0);
        return instruction;
    }

    static void validatePatched(Path patched, String rsa, int gamePort, int httpPort) throws Exception {
        boolean modulus = false, game = false, worldPort = false, loopback = false;
        for (String jar : List.of(INJECTED, CLIENT)) try (ZipFile zip = new ZipFile(patched.resolve(jar).toFile())) {
            for (var entries = zip.entries(); entries.hasMoreElements();) {
                ZipEntry entry = entries.nextElement();
                if (!entry.getName().endsWith(".class")) continue;
                ClassNode c = new ClassNode(); new ClassReader(zip.getInputStream(entry).readAllBytes()).accept(c, 0);
                for (MethodNode method : c.methods) for (AbstractInsnNode ins : method.instructions) if (ins instanceof LdcInsnNode ldc) {
                    if (rsa.equals(ldc.cst)) modulus = true;
                    if (jar.equals(INJECTED) && Integer.valueOf(43594).equals(ldc.cst)) throw new IllegalStateException("Unpatched live game port in " + c.name);
                    if (jar.equals(INJECTED) && Integer.valueOf(gamePort).equals(ldc.cst)) game = true;
                    if ("127.1.45.2".equals(ldc.cst)) throw new IllegalStateException("Unnormalized loopback");
                    if (c.name.equals("net/runelite/client/game/WorldClient")) {
                        if (Integer.valueOf(httpPort).equals(ldc.cst)) worldPort = true;
                        if ("127.0.0.1".equals(ldc.cst)) loopback = true;
                    }
                }
            }
        }
        if (!modulus || !game || !worldPort || !loopback) throw new IllegalStateException("Required RSA/game/world-list patches absent");
        System.out.println("Verified patched RSA, private game port and loopback world-list route");
    }

    static void normalize(Path source, Path target, int httpPort) throws Exception {
        try (ZipFile zip = new ZipFile(source.toFile()); ZipOutputStream output = new ZipOutputStream(Files.newOutputStream(target))) {
            for (var entries = zip.entries(); entries.hasMoreElements();) {
                ZipEntry entry = entries.nextElement();
                String name = entry.getName();
                if (name.matches("META-INF/.*\\.(SF|RSA|DSA)")) continue;
                byte[] bytes = zip.getInputStream(entry).readAllBytes();
                if (name.endsWith(".class")) {
                    ClassNode c = new ClassNode(); new ClassReader(bytes).accept(c, 0);
                    boolean changed = false;
                    for (MethodNode method : c.methods) for (AbstractInsnNode ins : method.instructions) {
                        if (ins instanceof LdcInsnNode ldc && "127.1.45.2".equals(ldc.cst)) {ldc.cst = "127.0.0.1"; changed = true;}
                    }
                    if (changed) {ClassWriter writer = new ClassWriter(0); c.accept(writer); bytes = writer.toByteArray();}
                }
                if (name.equals("net/runelite/client/runelite.properties")) {
                    String properties = new String(bytes, StandardCharsets.ISO_8859_1);
                    properties = properties.replaceAll("(?m)^(runelite.jav_config(?:_backup)?)=.*$", "$1=http://127.0.0.1:" + httpPort + "/jav_config.ws");
                    properties = properties.replaceAll("(?m)^runelite.discord.enable=.*$", "runelite.discord.enable=false");
                    // The command-line local URL is authoritative; no official fallback.
                    bytes = properties.getBytes(StandardCharsets.ISO_8859_1);
                }
                output.putNextEntry(new ZipEntry(name)); output.write(bytes); output.closeEntry();
            }
        }
    }
}
