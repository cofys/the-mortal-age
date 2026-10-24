// CDP_PORT=<your own Chrome debugging port> node client/tests/npc-gpu-pose.browser.cjs
// A secure blank tab is sufficient; no game server, login or scene changes are needed.
const assert = require('node:assert/strict');
const cp = require('node:child_process');
// Run against a secure Chrome tab with CDP_PORT set to your own debugging port.
const root = require('node:path').resolve(__dirname, '../..');
const esbuild = require(root + '/client/node_modules/esbuild'), WebSocket = require(root + '/client/node_modules/ws');
async function probe(cases, codes) {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter)
        throw Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    const errors = [];
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    const decode = s => Uint8Array.from(atob(s), x => x.charCodeAt(0));
    const buffer = (bytes, usage) => { const b = device.createBuffer({ size: Math.max(4, bytes.byteLength), usage: usage | GPUBufferUsage.COPY_DST }); if (bytes.byteLength)
        device.queue.writeBuffer(b, 0, bytes); return b; };
    const results = [];
    try {
    for (const [mode, original] of Object.entries(codes)) {
        const compilation = await device.createShaderModule({ code: original }).getCompilationInfo();
        const bad = compilation.messages.filter(m => m.type === 'error');
        if (bad.length)
            throw Error(mode + ':' + bad.map(x => x.message).join(';'));
        const entry = mode.startsWith('depth') ? 'vs_npc_depth' : 'vs_npc', start = original.indexOf('@vertex\nfn ' + entry + '('), brace = original.indexOf('{', start), prefixEnd = original.indexOf('\n    var localPos', brace);
        let level = 1, end = brace + 1;
        for (; level && end < original.length; end++) {
            if (original[end] === '{')
                level++;
            if (original[end] === '}')
                level--;
        }
        if (start < 0 || prefixEnd < 0) throw Error('Production NPC vertex prefix missing');
        const signature = original.slice(start, brace).replace(/\)\s*->/, ', @builtin(vertex_index) probeIndex: u32) ->').replace('DepthVertexOutput', 'ActorVertexOutput');
        for (const test of cases) {
            const vertices = decode(test.vertices), labels = decode(test.labels), matrices = decode(test.matrices), expected = new Float32Array(decode(test.expected).buffer), count = expected.length / 3;
            const code = original.slice(0, start) + signature + '{' + original.slice(brace + 1, prefixEnd) + `\n var out: ActorVertexOutput;out.position=vec4<f32>((f32(probeIndex)+0.5)*2.0/${count}.0-1.0,0.0,0.0,1.0);out.v_color=vec4<f32>(vertex.pos,1.0);return out;\n}` + original.slice(end) + '\n@fragment fn fs_probe(input: ActorVertexOutput)->@location(0)vec4<f32>{return input.v_color;}';
            const module = device.createShaderModule({ code });
            const info = await module.getCompilationInfo();
            if (info.messages.some(m => m.type === 'error'))
                throw Error(info.messages.map(m => m.message).join(';'));
            const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: entry, buffers: [{ arrayStride: 20, attributes: [{ shaderLocation: 0, offset: 0, format: 'uint32x4' }, { shaderLocation: 3, offset: 16, format: 'uint32' }] }, { arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: 'uint32' }] }] }, fragment: { module, entryPoint: 'fs_probe', targets: [{ format: 'rgba32float' }] }, primitive: { topology: 'point-list' } });
            const scene = buffer(new Uint8Array(272), GPUBufferUsage.UNIFORM), rows = buffer(new Uint8Array(128), GPUBufferUsage.STORAGE), vbo = buffer(vertices, GPUBufferUsage.VERTEX), lbo = buffer(labels, GPUBufferUsage.VERTEX);
            const actor = device.createTexture({ size: [16, 1], format: 'rgba16uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
            device.queue.writeTexture({ texture: actor }, new Uint8Array(128), { bytesPerRow: 128 }, [16, 1]);
            const poseWidth = matrices.byteLength / 16, pose = device.createTexture({ size: [poseWidth, 1], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
            device.queue.writeTexture({ texture: pose }, matrices, { bytesPerRow: poseWidth * 16 }, [poseWidth, 1]);
            const groups = [device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: scene } }] }), device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [] }), device.createBindGroup({ layout: pipeline.getBindGroupLayout(2), entries: [{ binding: 0, resource: { buffer: rows } }] }), device.createBindGroup({ layout: pipeline.getBindGroupLayout(3), entries: [{ binding: 0, resource: actor.createView() }, ...(original.slice(brace + 1, prefixEnd).includes('u_poseTexture') ? [{ binding: 1, resource: pose.createView() }] : [])] })];
            const target = device.createTexture({ size: [count, 1], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }), stride = Math.ceil(count * 16 / 256) * 256, readback = device.createBuffer({ size: stride, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            const encoder = device.createCommandEncoder(), pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
            pass.setPipeline(pipeline);
            groups.forEach((group, index) => pass.setBindGroup(index, group));
            pass.setVertexBuffer(0, vbo);
            pass.setVertexBuffer(1, lbo);
            pass.draw(count);
            pass.end();
            encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: stride }, [count, 1]);
            device.queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            const actual = new Float32Array(readback.getMappedRange());
            let max = 0, drawn = 0;
            for (let i = 0; i < count; i++) {
                if (actual[i * 4 + 3] === 1)
                    drawn++;
                for (let a = 0; a < 3; a++) {
                    const error = Math.abs(actual[i * 4 + a] - expected[i * 3 + a]);
                    if (!Number.isFinite(error)) throw Error('Non-finite GPU coordinate');
                    max = Math.max(max, error);
                }
            }
            results.push({ mode, id: test.id, sequence: test.sequence, count, drawn, max });
            readback.unmap();
            for (const b of [scene, rows, vbo, lbo, readback])
                b.destroy();
            for (const t of [actor, pose, target])
                t.destroy();
        }
    }
    await device.queue.onSubmittedWorkDone();
    return { results, errors };
    } finally { device.destroy(); }
}
(async () => {
    const out = cp.execFileSync(process.execPath, [root + '/client/node_modules/tsx/dist/cli.mjs', root + '/client/tests/npc-gpu-pose.test.ts'], { env: { ...process.env, NPC_GPU_CAPTURE: '1' }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const cases = JSON.parse(out.split('\n').find(x => x.startsWith('NPC_GPU_CAPTURE=')).slice(16));
    assert.equal(cases.length, 4, 'Capture scaled and unscaled idle/walk NPC meshes');
    const bundled = esbuild.buildSync({ stdin: { contents: `import {createActorShaderModule} from '${root}/client/render/webgpu/shaders/actor.wgsl.ts';import {HD_SCENE_SHADERS} from '${root}/client/game/plugins/hd/webgpu/hdSceneShaders.ts';const d={createShaderModule:(x:any)=>x};export const codes={scene:createActorShaderModule(d as any,{alpha:false}).code,alpha:createActorShaderModule(d as any,{alpha:true}).code,hd:createActorShaderModule(d as any,{alpha:false,ext:HD_SCENE_SHADERS}).code,hdAlpha:createActorShaderModule(d as any,{alpha:true,ext:HD_SCENE_SHADERS}).code,depth:createActorShaderModule(d as any,{alpha:false,ext:HD_SCENE_SHADERS,depth:true}).code,depthAlpha:createActorShaderModule(d as any,{alpha:true,ext:HD_SCENE_SHADERS,depth:true}).code};`, loader: 'ts', resolveDir: root }, bundle: true, format: 'cjs', write: false }).outputFiles[0].text;
    const module = { exports: {} };
    new Function('module', 'exports', bundled)(module, module.exports);
    const codes = module.exports.codes;
    const tabs = await (await fetch('http://localhost:' + (process.env.CDP_PORT || 9333) + '/json/list')).json(), tab = tabs.find(t => t.type === 'page');
    if (!tab)
        throw Error('Open a secure Chrome tab on the requested debugging port');
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
    const timeout = setTimeout(() => { console.error('GPU NPC readback timed out'); process.exitCode = 1; ws.close(); }, 30000);
    ws.on('message', raw => { const d = JSON.parse(raw); if (d.id !== 1)
        return; clearTimeout(timeout); if (d.error || d.result.exceptionDetails) {
        console.error(JSON.stringify({ error: d.error, exception: d.result.exceptionDetails?.exception?.description?.slice(0, 2500) }));
        process.exitCode = 1;
    }
    else {
        const result = d.result.result.value;
        console.log(JSON.stringify({ passes: result.results.length, vertices: result.results.reduce((sum, test) => sum + test.drawn, 0), maxError: Math.max(...result.results.map(test => test.max)), errors: result.errors }));
        if (result.errors.length || result.results.some(x => x.count !== x.drawn || x.max >= 1 / 1024))
            process.exitCode = 1;
    } ws.close(); });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(${probe.toString()})(${JSON.stringify(cases)},${JSON.stringify(codes)})`, awaitPromise: true, returnByValue: true } }));
})().catch(e => { console.error(String(e)); process.exitCode = 1; });
