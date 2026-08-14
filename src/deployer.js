const fs = require("node:fs");
const { spawn } = require("node:child_process");

const { STEP_TIMEOUT_MS, LOG_TAIL_BYTES } = require("./config");
const { deployments } = require("./db");

// One deploy per repository at a time. Pushes arriving mid-deploy collapse
// into a single follow-up run instead of stacking up.
const queue = new Map();

function makeLog(repo) {
    const lines = [];
    let bytes = 0;

    return {
        write(line) {
            console.log(`${new Date().toISOString()} [${repo}] ${line}`);
            lines.push(line);
            bytes += line.length + 1;

            while (bytes > LOG_TAIL_BYTES && lines.length > 1) {
                bytes -= lines.shift().length + 1;
            }
        },
        text: () => lines.join("\n"),
    };
}

// No shell involved: arguments are passed as an array, so a repository or
// branch name can never be interpreted as a command.
function runStep(log, cwd, command, args) {
    return new Promise((resolve, reject) => {
        log.write(`$ ${command} ${args.join(" ")}`);

        const child = spawn(command, args, { cwd, shell: false });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`${command} timed out after ${STEP_TIMEOUT_MS}ms`));
        }, STEP_TIMEOUT_MS);

        const pipe = (stream) => {
            stream.setEncoding("utf8");
            let buffer = "";
            stream.on("data", (chunk) => {
                buffer += chunk;
                const parts = buffer.split("\n");
                buffer = parts.pop();
                for (const line of parts) if (line.trim()) log.write(line);
            });
        };

        pipe(child.stdout);
        pipe(child.stderr);

        child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });

        child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`${command} exited with code ${code}`));
        });
    });
}

function buildSteps(repo, branch) {
    const compose = ["compose"];
    if (repo.compose_file) compose.push("-f", repo.compose_file);

    const steps = [
        ["git", ["fetch", "--prune", "origin"]],
        ["git", ["reset", "--hard", `origin/${branch}`]],
    ];

    if (repo.clean_untracked) steps.push(["git", ["clean", "-fd"]]);

    steps.push(["docker", [...compose, "up", "-d", "--build"]]);
    if (repo.prune_images) steps.push(["docker", ["image", "prune", "-f"]]);

    return steps;
}

async function runDeploy(repo, branch, commitSha, source) {
    const log = makeLog(repo.name);
    const startedAt = Date.now();
    const id = deployments.start(repo.id, branch, commitSha, source);

    try {
        if (!fs.existsSync(`${repo.path}/.git`)) {
            throw new Error(`${repo.path} is not a git checkout`);
        }

        for (const [command, args] of buildSteps(repo, branch)) {
            await runStep(log, repo.path, command, args);
        }

        const durationMs = Date.now() - startedAt;
        deployments.finish(id, { status: "success", log: log.text(), durationMs });
        log.write(`deployed in ${Math.round(durationMs / 1000)}s`);
    } catch (err) {
        log.write(`FAILED: ${err.message}`);
        deployments.finish(id, {
            status: "failed",
            error: err.message,
            log: log.text(),
            durationMs: Date.now() - startedAt,
        });
    }

    deployments.prune(repo.id);
}

async function drain(repo, job) {
    let next = job;

    while (next) {
        await runDeploy(repo, next.branch, next.commitSha, next.source);

        const entry = queue.get(repo.name);
        next = entry.pending;
        entry.pending = null;
    }

    queue.delete(repo.name);
}

function schedule(repo, { branch, commitSha = null, source = "webhook" }) {
    const entry = queue.get(repo.name);

    if (entry) {
        entry.pending = { branch, commitSha, source };
        return "queued";
    }

    queue.set(repo.name, { pending: null });
    void drain(repo, { branch, commitSha, source });

    return "started";
}

const running = () => [...queue.keys()];

module.exports = { schedule, running };
