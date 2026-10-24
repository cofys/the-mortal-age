type PendingUpdate = {
    apply: () => void;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
};

/** Scene reads stay consistent across yields; newer snapshots replace queued vars/NPC updates. */
export class WorkerInputUpdates {
    private readers = 0;
    private readonly pending = new Map<string | symbol, PendingUpdate>();

    hold(): () => void {
        this.readers++;
        return () => {
            if (--this.readers !== 0) return;
            const pending = [...this.pending.values()];
            this.pending.clear();
            for (const update of pending) {
                try { update.apply(); update.resolve(); }
                catch (error) { update.reject(error); }
            }
        };
    }

    update(key: string | symbol, apply: () => void): Promise<void> {
        if (!this.readers) {
            try { apply(); return Promise.resolve(); }
            catch (error) { return Promise.reject(error); }
        }
        const previous = this.pending.get(key);
        if (previous) { previous.apply = apply; return previous.promise; }
        let resolve!: () => void, reject!: (error: unknown) => void;
        const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        this.pending.set(key, { apply, promise, resolve, reject });
        return promise;
    }
}
