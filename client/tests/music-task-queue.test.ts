import { strict as assert } from "node:assert";

import { MusicSystem } from "../game/audio/MusicSystem";

// The OSRS music task queue (AddRequest -> LoadSongs -> Delay/Start/FadeIn beside Delay/FadeOut/Clear)
// with fake synths. Live (rsprox revs 236-239): a jingle is preceded by the current track with zero
// fades and the client resumes that track when the jingle ends; a track that cannot be loaded must
// not silence the music that is already playing, nor stop a jingle from giving the area track back.

type Load = { id: number; kind: "music" | "jingle"; resolve: (ok: boolean) => void; reject: (e: Error) => void };

class FakeSynth {
    playing = false;
    looping = true;
    gain = 1;
    readonly loads: Load[] = [];
    constructor(readonly name: string) {}
    loadTrack(id: number): Promise<boolean> {
        return new Promise((resolve, reject) => this.loads.push({ id, kind: "music", resolve, reject }));
    }
    loadJingle(id: number): Promise<boolean> {
        return new Promise((resolve, reject) => this.loads.push({ id, kind: "jingle", resolve, reject }));
    }
    play() { this.playing = true; }
    stop() { this.playing = false; }
    setVolume() {}
    setLooping(looping: boolean) { this.looping = looping; }
    setOutputGain(gain: number) { this.gain = gain; }
    getOutputGain() { return this.gain; }
    isReady() { return true; }
    dispose() {}
    /** Settle the pending load of `id`. */
    settle(id: number, ok: boolean): void {
        const index = this.loads.findIndex((l) => l.id === id);
        assert.ok(index >= 0, `${this.name} was asked to load ${id}`);
        const [load] = this.loads.splice(index, 1);
        load.resolve(ok);
    }
}

function system() {
    const music = new MusicSystem({} as any) as any;
    const synths = [new FakeSynth("a"), new FakeSynth("b"), new FakeSynth("c")];
    [music.realtimeSynth, music.secondarySynth, music.tertiarySynth] = synths;
    music.osrsSynthRefCount.clear();
    for (const synth of synths) music.osrsSynthRefCount.set(synth, 0);
    const pending = () => synths.flatMap((s) => s.loads.map((l) => ({ synth: s, ...l })));
    const settle = (id: number, ok: boolean) => {
        const load = pending().find((l) => l.id === id);
        assert.ok(load, `a synth was asked to load ${id}; pending: ${pending().map((l) => l.id)}`);
        load!.synth.settle(id, ok);
    };
    const playingIds = () =>
        (music.getOsrsMusicDebugState().songs as Array<{ trackId: number; started: boolean }>)
            .filter((s) => s.started)
            .map((s) => s.trackId);
    const state = () => music.getOsrsMusicDebugState();
    return { music: music as MusicSystem, synths, settle, playingIds, state, pending };
}

/** Run `ticks` client ticks, letting settled load promises run between them. */
async function run(music: MusicSystem, ticks: number): Promise<void> {
    for (let i = 0; i < ticks; i++) {
        music.tick(1);
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

async function main() {
    // 1. A dual request whose secondary cannot be loaded still starts its primary.
    {
        const { music, settle, playingIds, state } = system();
        music.playDualTracks(10, 11, 0, 0, 0, 0);
        await run(music, 2);
        settle(10, true);
        settle(11, false);
        await run(music, 6);
        assert.deepEqual(playingIds(), [10], "the primary plays");
        assert.deepEqual(state().songs.map((s: any) => s.trackId), [10], "the failed secondary is gone");
        assert.equal(state().taskQueueLength, 0, "the queue drained");
    }

    // 2. A replacement track that cannot be loaded leaves the current track playing, and the
    //    next request still works.
    {
        const { music, synths, settle, playingIds, state } = system();
        music.playSong(20, 0, 0, 0, 0);
        await run(music, 2);
        settle(20, true);
        await run(music, 4);
        assert.deepEqual(playingIds(), [20]);
        const synth20 = synths.find((s) => s.playing)!;

        music.playSong(21, 0, 60, 60, 0);
        await run(music, 2);
        settle(21, false);
        await run(music, 4);
        assert.equal(synth20.playing, true, "the old track was not cut");
        assert.deepEqual(playingIds(), [20], "it is still the song in the list");
        assert.equal(state().taskQueueLength, 0, "nothing stalls");

        music.playSong(22, 0, 0, 0, 0);
        await run(music, 2);
        settle(22, true);
        await run(music, 6);
        assert.deepEqual(playingIds(), [22], "a later request replaces it normally");
        assert.equal(synth20.playing, false);
    }

    // 3. A jingle that cannot be loaded gives the area track straight back.
    {
        const { music, settle, playingIds } = system();
        music.playSong(30, 0, 0, 0, 0);
        await run(music, 2);
        settle(30, true);
        await run(music, 4);
        assert.deepEqual(playingIds(), [30]);

        void music.playJingle(500, 0);
        assert.equal(music.playingJingle, true);
        await run(music, 2);
        settle(500, false);
        await run(music, 4); // the failure lands, the area track is re-queued and asked to load
        assert.equal(music.playingJingle, false, "the failed jingle is over");
        settle(30, true);
        await run(music, 6);
        assert.deepEqual(playingIds(), [30], "the area track resumed");
    }

    // 4. A jingle that plays to its end gives the area track back with the fades that came
    //    with it; a song packet during the jingle becomes the track to resume.
    {
        const { music, synths, settle, playingIds, state } = system();
        music.playSong(40, 0, 60, 60, 0);
        await run(music, 2);
        settle(40, true);
        await run(music, 70);
        assert.deepEqual(playingIds(), [40]);

        void music.playJingle(501, 0);
        await run(music, 2);
        settle(501, true);
        await run(music, 6);
        const jingleSynth = synths.find((s) => s.playing)!;
        assert.ok(jingleSynth, "the jingle plays");
        assert.equal(jingleSynth.looping, false);
        assert.deepEqual(playingIds(), [501]);

        music.playSong(41, 0, 0, 0, 0);
        await run(music, 2);
        assert.equal(jingleSynth.playing, true, "a song packet during the jingle does not cut it");
        assert.deepEqual(state().queuedAfterJingle?.trackIds, [41], "it is the track to resume");

        jingleSynth.playing = false; // the synth reached the end of the jingle
        await run(music, 4);
        assert.equal(music.playingJingle, false);
        settle(41, true);
        await run(music, 6);
        assert.deepEqual(playingIds(), [41], "the area track resumed with its own fades (none)");
    }

    // 5. A track that failed to load is not what a later jingle resumes: the track still playing is.
    {
        const { music, settle, playingIds, state } = system();
        music.playSong(50, 0, 0, 0, 0);
        await run(music, 2);
        settle(50, true);
        await run(music, 6);
        music.playSong(51, 0, 0, 0, 0);
        await run(music, 2);
        settle(51, false);
        await run(music, 4);
        assert.deepEqual(playingIds(), [50]);

        void music.playJingle(502, 0);
        await run(music, 2);
        settle(502, true);
        await run(music, 6);
        assert.deepEqual(state().queuedAfterJingle?.trackIds, [50], "the playing track is the one to resume");
    }

    // 6. When the track to resume after a jingle cannot be loaded, the finished jingle does not
    //    linger as a song and the queue is empty.
    {
        const { music, synths, settle, state } = system();
        music.playSong(60, 0, 0, 0, 0);
        await run(music, 2);
        settle(60, true);
        await run(music, 6);
        void music.playJingle(503, 0);
        await run(music, 2);
        settle(503, true);
        await run(music, 6);
        const jingleSynth = synths.find((s) => s.playing)!;
        jingleSynth.playing = false;
        await run(music, 4);
        settle(60, false);
        await run(music, 4);
        assert.deepEqual(state().songs, [], "nothing is left playing or pending");
        assert.equal(state().taskQueueLength, 0);
        assert.equal(music.playingJingle, false);
    }

    // 7. Music volume 0: the track is remembered but nothing loads; turning the volume up plays it.
    {
        const { music, settle, playingIds, pending, state } = system();
        music.setVolume(0);
        music.playSong(70, 0, 60, 60, 0);
        await run(music, 4);
        assert.deepEqual(pending(), [], "nothing is loaded while the volume is 0");
        assert.deepEqual(state().songs, []);
        music.setVolume(0.5);
        await run(music, 3);
        settle(70, true);
        await run(music, 6);
        assert.deepEqual(playingIds(), [70], "the remembered track plays once there is volume");
    }

    // 8. Volume 0 while a track plays keeps it (silent), and volume back up does not restart it.
    {
        const { music, settle, playingIds, pending, state } = system();
        music.playSong(71, 0, 0, 0, 0);
        await run(music, 2);
        settle(71, true);
        await run(music, 6);
        music.setVolume(0);
        await run(music, 3);
        assert.deepEqual(playingIds(), [71], "the song is kept");
        music.setVolume(0.5);
        await run(music, 3);
        assert.deepEqual(pending(), [], "no reload");
        assert.deepEqual(playingIds(), [71]);
        assert.equal(state().taskQueueLength, 0);
    }

    // 9. Muted works the same way as volume 0.
    {
        const { music, settle, playingIds, pending } = system();
        music.setMuted(true);
        music.playSong(72, 0, 0, 0, 0);
        await run(music, 4);
        assert.deepEqual(pending(), [], "nothing is loaded while muted");
        music.setMuted(false);
        await run(music, 3);
        settle(72, true);
        await run(music, 6);
        assert.deepEqual(playingIds(), [72], "unmuting plays the remembered track");
    }

    console.log("music-task-queue.test.ts: all tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
