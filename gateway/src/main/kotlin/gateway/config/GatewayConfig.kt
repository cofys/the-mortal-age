package gateway.config

import java.nio.file.Files
import java.nio.file.Path

/**
 * Settings come from the repository's root `.env`, the same file `scripts/wt` writes each
 * worktree's ports into, so the gateway always pairs with this checkout's tsps server.
 * Process environment variables win over `.env`.
 */
data class GatewayConfig(
    val root: Path,
    val gatewayPort: Int,
    val websocketPort: Int,
    val cacheDirectory: Path,
    val keyFile: Path,
) {
    val tspsUrl: String get() = "ws://127.0.0.1:$websocketPort/"

    companion object {
        const val DEFAULT_GATEWAY_PORT = 43595
        const val DEFAULT_WEBSOCKET_PORT = 43594

        fun load(root: Path = Path.of("").toAbsolutePath()): GatewayConfig {
            val env = readEnv(root.resolve(".env")) + System.getenv()
            val target = Files.readString(root.resolve("server/target.txt")).trim()
            return GatewayConfig(
                root = root,
                gatewayPort = env["GATEWAY_PORT"]?.toInt() ?: DEFAULT_GATEWAY_PORT,
                websocketPort = env["WEBSOCKET_PORT"]?.toInt() ?: DEFAULT_WEBSOCKET_PORT,
                cacheDirectory = root.resolve("server/caches").resolve(target),
                keyFile = root.resolve("gateway/keys/rsa.txt"),
            )
        }

        private fun readEnv(file: Path): Map<String, String> {
            if (!Files.exists(file)) return emptyMap()
            return Files.readAllLines(file)
                .map { it.trim() }
                .filter { it.isNotEmpty() && !it.startsWith("#") && '=' in it }
                .associate { line -> line.substringBefore('=').trim() to line.substringAfter('=').trim().trim('"') }
        }
    }
}
