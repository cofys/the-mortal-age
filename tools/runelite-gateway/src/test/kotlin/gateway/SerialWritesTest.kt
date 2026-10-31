package gateway
import kotlin.test.*
import java.util.concurrent.CompletableFuture
class SerialWritesTest {
 @Test fun queuesLoginAndHandshakeUntilPreviousFrameCompletes() {
  val events=mutableListOf<Int>();val first=CompletableFuture<Unit>();val second=CompletableFuture<Unit>()
  val q=SerialWrites{throw AssertionError(it)}
  q.submit{events.add(200);first};q.submit{events.add(204);second};q.submit{events.add(202);CompletableFuture.completedFuture(Unit)}
  assertEquals(listOf(200),events);first.complete(Unit);assertEquals(listOf(200,204),events);second.complete(Unit);assertEquals(listOf(200,204,202),events)
 }
 @Test fun asynchronousSendFailureIsReportedOnceAndStopsLaterWrites() {
  var failures=0;var writes=0;val pending=CompletableFuture<Unit>();val q=SerialWrites{failures++}
  q.submit{writes++;pending};q.submit{writes++;CompletableFuture.completedFuture(Unit)}
  pending.completeExceptionally(IllegalStateException("Send pending"));q.submit{writes++;CompletableFuture.completedFuture(Unit)}
  assertEquals(1,writes);assertEquals(1,failures)
 }
}
