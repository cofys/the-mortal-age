// Uploads a built directory over FTPS: node ftp-upload.mjs <local dir> <remote dir>
// Runs in the deploy job, which holds the FTP secrets and runs no other repo code.
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Client } from "basic-ftp";

const [local, remote] = process.argv.slice(2);
const client = new Client();

async function buildFiles(directory, prefix = "") {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = path.posix.join(prefix, entry.name);
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await buildFiles(file, relative));
        else if (entry.isFile()) files.push({ relative, local: file, size: (await stat(file)).size });
        else throw new Error(`Unsupported build entry: ${relative}`);
    }
    return files;
}

try {
    for (const key of ["FTP_HOST", "FTP_USER", "FTP_PASSWORD"]) {
        if (!process.env[key]?.trim()) throw new Error(`Missing ${key}`);
    }
    if (!local || !remote?.startsWith("/") || remote === "/" || remote.split("/").includes("..")) {
        throw new Error("Usage: ftp-upload.mjs <local dir> <absolute, non-root remote dir>");
    }
    const port = Number(process.env.FTP_PORT || 21);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid FTP_PORT");

    const files = await buildFiles(local);
    if (!files.some(file => file.relative === "index.html")) throw new Error("Build is missing index.html");
    // Publish the entry point only after every asset it references has arrived.
    files.sort((a, b) => Number(a.relative === "index.html") - Number(b.relative === "index.html"));
    const total = files.reduce((sum, file) => sum + file.size, 0);
    console.log(`${files.length} files (${(total / 1024 / 1024).toFixed(1)} MiB) → ${remote}`);

    await client.access({
        host: process.env.FTP_HOST,
        port,
        user: process.env.FTP_USER,
        password: process.env.FTP_PASSWORD,
        secure: true, // Explicit FTPS, with certificate validation.
        secureOptions: { servername: process.env.FTP_TLS_SERVERNAME || process.env.FTP_HOST },
    });
    for (const file of files) {
        await client.ensureDir(path.posix.join(remote, path.posix.dirname(file.relative)));
        const name = path.posix.basename(file.relative);
        if (file.relative === "index.html") {
            await client.uploadFrom(file.local, "index.html.uploading");
            await client.rename("index.html.uploading", name);
        } else {
            await client.uploadFrom(file.local, name);
        }
    }
    console.log("Deployment complete.");
} catch (error) {
    // Never echo credentials if a remote server includes them in an error response.
    const message = String(error.message).split(process.env.FTP_PASSWORD || "\0").join("[redacted]");
    console.error(`Deployment failed: ${message}`);
    process.exitCode = 1;
} finally {
    client.close();
}
