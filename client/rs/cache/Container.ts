// import { Xtea } from "../../common/utils/Xtea";
import { Bzip2 } from "../compression/Bzip2";
import { CompressionType } from "../compression/CompressionType";
import { Gzip } from "../compression/Gzip";
import { Xtea } from "../crypto/Xtea";
import { ByteBuffer } from "../io/ByteBuffer";

/** Time spent decompressing cache data in this thread (read by `?map-profile=1` map timings). */
export const decompressStats = { gzipMs: 0, gzipCount: 0, bzip2Ms: 0, bzip2Count: 0 };

export class Container {
    static decode(buffer: ByteBuffer, key?: number[]): Container {
        if (buffer.remaining === 0) {
            throw new Error("Empty container");
        }
        const compression: CompressionType = buffer.readUnsignedByte();
        const size = buffer.readInt();
        if (Xtea.isValidKey(key)) {
            Xtea.decrypt(buffer, buffer.offset, buffer.offset + 4 + size, key);
        }
        switch (compression) {
            case CompressionType.None:
                return new Container(compression, buffer.readBytes(size));
            case CompressionType.Bzip2:
            case CompressionType.Gzip:
                const actualSize = buffer.readInt() & 0xffffffff;

                const data = buffer.readUnsignedBytes(size);

                let decompressed: Int8Array;

                const startedAt = performance.now();
                if (compression === CompressionType.Bzip2) {
                    decompressed = Bzip2.decompress(data, actualSize);
                    decompressStats.bzip2Ms += performance.now() - startedAt;
                    decompressStats.bzip2Count++;
                } else {
                    decompressed = Gzip.decompress(data);
                    decompressStats.gzipMs += performance.now() - startedAt;
                    decompressStats.gzipCount++;
                }

                if (decompressed.length !== actualSize) {
                    throw new Error(
                        "Container: Size mismatch. Compressed: " +
                            actualSize +
                            ", Decompressed: " +
                            decompressed.length +
                            ", Type: " +
                            CompressionType[compression],
                    );
                }
                return new Container(compression, decompressed);
            default:
                throw new Error("Container: Unsupported compression: " + compression);
        }
    }

    constructor(
        readonly compression: CompressionType,
        readonly data: Int8Array,
    ) {}
}
