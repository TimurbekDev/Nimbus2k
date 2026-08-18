const { DOCKER_BIN, DOCKER_TIMEOUT_MS, STEP_TIMEOUT_MS } = require("../config");
const { capture, stream } = require("../lib/exec");
const logger = require("../lib/logger");

const log = logger("rollback");

// The tag the images of a running stack are given before a build replaces them.
// Without it the old image is dangling the moment the new one takes its name,
// and the prune step would delete the only thing a rollback could return to.
const PREV_TAG = "nimbus-prev";

// Project name -> [{ repository, tag, id }] of what was running before the last
// build. Kept after a successful deploy too: one generation of images per
// project is a small price for being able to put the previous stack back.
const snapshots = new Map();

// `docker compose images --format json` emits a JSON array on current compose
// and one object per line on older ones.
function parseImages(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed) return [];

    // A stack with nothing built prints a bare `null` on some compose versions,
    // and a JSON null is not a row to read fields off.
    const rows = (value) => (Array.isArray(value) ? value : [value]).filter((item) => item && typeof item === "object");

    try {
        return rows(JSON.parse(trimmed));
    } catch {
        // Fall through to the line-oriented form.
    }

    return trimmed.split("\n").flatMap((line) => {
        try {
            return rows(JSON.parse(line));
        } catch {
            return [];
        }
    });
}

// An image built from the compose file, named and identified. Anything without
// both is not something a rollback can point a tag back at.
function usable(image) {
    if (!image || typeof image !== "object") return null;

    const repository = image.Repository || image.repository;
    const tag = image.Tag || image.tag;
    const id = image.ID || image.Id || image.id;

    if (!repository || !id || repository === "<none>") return null;
    if (!tag || tag === "<none>" || tag === PREV_TAG) return null;

    return { repository, tag, id };
}

/**
 * Tags every image the stack is currently running as `<repository>:nimbus-prev`
 * and remembers which image id each service tag pointed at. Runs before the
 * build, while the old containers are still up.
 */
async function snapshot(project, composeArgs) {
    snapshots.delete(project.name);

    // A stack that has never been up has no images, which is an answer rather
    // than an error: the first deploy has nothing to roll back to.
    const { code, stdout, stderr } = await capture(DOCKER_BIN, [...composeArgs, "images", "--format", "json"], {
        cwd: project.path,
        timeoutMs: DOCKER_TIMEOUT_MS,
        allowFailure: true,
    });

    if (code !== 0) {
        log.warn("image snapshot skipped", { project: project.name, detail: (stderr || "").split("\n")[0] });
        return "no images to snapshot — this deploy has nothing to roll back to";
    }

    const seen = new Set();
    const records = [];

    for (const image of parseImages(stdout)) {
        const record = usable(image);
        if (!record) continue;

        const key = `${record.repository}:${record.tag}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const tagged = await capture(DOCKER_BIN, ["tag", record.id, `${record.repository}:${PREV_TAG}`], {
            timeoutMs: DOCKER_TIMEOUT_MS,
            allowFailure: true,
        });

        // An image that cannot be held on to cannot be rolled back to, so it is
        // left out of the record rather than promising something false.
        if (tagged.code !== 0) {
            log.warn("could not tag image", { project: project.name, image: key });
            continue;
        }

        records.push(record);
    }

    if (records.length === 0) return "no images to snapshot — this deploy has nothing to roll back to";

    snapshots.set(project.name, records);

    return `kept ${records.length} image${records.length === 1 ? "" : "s"} as :${PREV_TAG} — ${records.map((r) => r.repository).join(", ")}`;
}

const has = (name) => (snapshots.get(name) || []).length > 0;

/**
 * Points every service tag back at the image it had before the build and brings
 * the stack up on it. Returns false when there was nothing to go back to.
 */
async function rollback(project, composeArgs, onLine) {
    const records = snapshots.get(project.name);
    if (!records || records.length === 0) return false;

    for (const record of records) {
        const restored = await capture(DOCKER_BIN, ["tag", record.id, `${record.repository}:${record.tag}`], {
            timeoutMs: DOCKER_TIMEOUT_MS,
            allowFailure: true,
        });

        if (restored.code !== 0) {
            throw new Error(`could not restore ${record.repository}:${record.tag} — the previous image is gone`);
        }
    }

    // No `--build`: the point is to run exactly what was running before. No
    // `--wait` either, because a rollback that is unhealthy has nowhere left
    // to go, and the operator should see the containers rather than a timeout.
    await stream(DOCKER_BIN, [...composeArgs, "up", "-d", "--force-recreate", "--remove-orphans"], {
        cwd: project.path,
        timeoutMs: STEP_TIMEOUT_MS,
        onLine,
    });

    return true;
}

const forget = (name) => snapshots.delete(name);

module.exports = { snapshot, rollback, has, forget, PREV_TAG };
