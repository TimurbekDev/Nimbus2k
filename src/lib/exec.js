const { spawn } = require("node:child_process");

// git shells out to ssh, and docker compose to buildkit, so killing the direct
// child leaves the grandchild running and holding the stdio pipes open - the
// step would hang instead of stopping. On anything but Windows the child leads
// its own process group, and the whole group goes down together.
const GROUPED = process.platform !== "win32";

function killTree(child) {
    try {
        if (GROUPED) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
    } catch {
        // Already gone between the check and the signal.
    }
}

// No shell anywhere in this file: arguments are passed as an array, so a
// repository name, a branch or a container id can never be interpreted as a
// command.
const BASE = { shell: false, detached: GROUPED, windowsHide: true };

/**
 * Runs a command to completion and buffers its output.
 *
 * Rejects on a non-zero exit unless `allowFailure` is set, in which case the
 * caller inspects `code` itself - useful for probes like `docker version`,
 * where a failure is an answer rather than an error.
 */
function capture(command, args, { cwd, env, timeoutMs = 30000, allowFailure = false, input } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { ...BASE, cwd, env: env && { ...process.env, ...env } });

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child);
        }, timeoutMs);

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });

        if (input !== undefined) child.stdin.end(input);

        child.on("error", (err) => {
            clearTimeout(timer);
            reject(new Error(`${command}: ${err.message}`));
        });

        child.on("close", (code) => {
            clearTimeout(timer);

            if (timedOut) return reject(new Error(`${command} timed out after ${timeoutMs}ms`));

            const result = { code, stdout, stderr };
            if (code === 0 || allowFailure) return resolve(result);

            const detail = (stderr.trim() || stdout.trim() || "no output").split("\n")[0];
            reject(Object.assign(new Error(`${command} exited with ${code}: ${detail}`), result));
        });
    });
}

/**
 * Runs a command and hands every complete stdout/stderr line to `onLine` as it
 * is produced. `register` receives a stop function so a caller can cancel a
 * step that is still running.
 */
function stream(command, args, { cwd, env, timeoutMs = 0, onLine, register } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { ...BASE, cwd, env: env && { ...process.env, ...env } });
        let stopped = false;

        const stop = () => {
            stopped = true;
            killTree(child);
        };

        if (register) register(stop);

        const timer = timeoutMs > 0
            ? setTimeout(() => {
                stop();
                reject(new Error(`${command} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
            : null;

        const done = () => { if (timer) clearTimeout(timer); };

        // `close` waits for every pipe to reach EOF, which a surviving
        // grandchild can delay indefinitely. Once the step has been killed, its
        // exit is enough to move on.
        child.on("exit", () => {
            if (!stopped) return;
            done();
            reject(new Error(`${command} was terminated`));
        });

        const pipe = (readable) => {
            readable.setEncoding("utf8");
            let buffer = "";

            readable.on("data", (chunk) => {
                buffer += chunk;
                const parts = buffer.split("\n");
                buffer = parts.pop();
                for (const line of parts) if (line.trim() && onLine) onLine(line);
            });

            readable.on("end", () => {
                if (buffer.trim() && onLine) onLine(buffer);
            });
        };

        pipe(child.stdout);
        pipe(child.stderr);

        child.on("error", (err) => {
            done();
            reject(err);
        });

        child.on("close", (code) => {
            done();
            if (code === 0) resolve({ code });
            else reject(Object.assign(new Error(`${command} exited with code ${code}`), { code }));
        });
    });
}

module.exports = { capture, stream, killTree, GROUPED };
