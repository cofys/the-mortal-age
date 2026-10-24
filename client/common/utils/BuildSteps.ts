/** Drain the same build steps synchronously for callers outside the scene worker. */
export function finishBuild<T>(steps: Generator<void, T>): T {
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
}

/** Keep intermediate geometry private while allowing worker cancellation/cache messages through. */
export class BuildSteps {
    constructor(readonly signal?: AbortSignal) {}

    check(): void { this.signal?.throwIfAborted(); }

    // shortcut: individual lighting/model operations stay synchronous; split them if cancellation latency warrants it.
    async run<T>(steps: Generator<void, T>): Promise<T> {
        let deadline = performance.now() + 8;
        try {
            for (;;) {
                this.check();
                const step = steps.next();
                if (step.done) return step.value;
                if (performance.now() >= deadline) {
                    // MessageChannel avoids the 4ms clamp on nested timers during long builds.
                    await new Promise<void>(resolve => {
                        const channel = new MessageChannel();
                        channel.port1.onmessage = () => {
                            channel.port1.close(); channel.port2.close(); resolve();
                        };
                        channel.port2.postMessage(null);
                    });
                    deadline = performance.now() + 8;
                }
            }
        } finally { steps.return(undefined as T); }
    }
}
