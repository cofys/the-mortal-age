/** Re-record only after a draw list repeats; continuously changing lists stay direct. */
export class SceneryDrawBundle {
    readonly commands: number[] = [];
    private previous: number[] = [];
    private pipeline?: GPURenderPipeline;
    private bindings: GPUBindGroup[] = [];
    private bundle?: GPURenderBundle;

    draw(
        device: GPUDevice,
        pass: GPURenderPassEncoder,
        pipeline: GPURenderPipeline,
        bindings: GPUBindGroup[],
        descriptor: GPURenderBundleEncoderDescriptor,
        encode: (encoder: GPURenderPassEncoder | GPURenderBundleEncoder) => void,
    ): void {
        const commands = this.commands;
        const same = pipeline === this.pipeline &&
            bindings.length === this.bindings.length && bindings.every((binding, i) => binding === this.bindings[i]) &&
            commands.length === this.previous.length && commands.every((value, i) => value === this.previous[i]);
        if (!same) {
            this.bundle = undefined;
            this.pipeline = pipeline;
            this.bindings = bindings;
            this.previous.length = commands.length;
            for (let i = 0; i < commands.length; i++) this.previous[i] = commands[i];
        }
        if (same && commands.length > 4 && device.createRenderBundleEncoder) {
            if (!this.bundle) {
                const encoder = device.createRenderBundleEncoder(descriptor);
                encode(encoder);
                this.bundle = encoder.finish();
            }
            pass.executeBundles([this.bundle]);
        } else encode(pass);
    }
}
