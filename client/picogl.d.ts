import * as PicoGL from "picogl";

declare module "picogl" {
    export interface App {
        /** PicoGL forwards numeric allocation sizes to VertexBuffer's constructor. */
        createIndexBuffer(type: number, itemSize: number, data: number, usage?: number): VertexBuffer;
    }

    export interface VertexBuffer {
        byteLength: number;
    }

    export interface DrawCall extends Omit<PicoGL.DrawCall, "numElements"> {
        offsets: number[];
        numElements: number[];
    }

    export interface Texture {
        bind(unit: number): void;
    }

    import PicoGL, {
        App,
        DrawCall,
        VertexArray,
        VertexBuffer,
        Texture,
        Timer,
        Program,
        UniformBuffer,
    } from "picogl";

    export default PicoGL;
    export {
        PicoGL,
        App,
        DrawCall,
        VertexArray,
        VertexBuffer,
        Texture,
        Timer,
        Program,
        UniformBuffer,
    };
}
