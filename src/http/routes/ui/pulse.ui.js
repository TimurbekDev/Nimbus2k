const crypto = require("node:crypto");
const express = require("express");

const projects = require("../../../db/projects.repo");
const deployments = require("../../../db/deployments.repo");
const { groups } = require("../../../db/groups.repo");
const deploy = require("../../../services/deploy.service");
const docker = require("../../../services/docker.service");

const router = express.Router();

/**
 * A fingerprint of everything that would make a page look different.
 *
 * The client polls this instead of re-fetching a whole page on a timer: a
 * rendered page is 20 kB of HTML that the browser then has to parse and swap in,
 * and almost every one of those refreshes used to find nothing had changed.
 *
 * Reads nothing expensive - the container list comes from the same cached
 * snapshot the pages use, and CPU numbers are deliberately excluded so a meter
 * twitching by a tenth of a percent does not count as a change.
 */
async function fingerprint() {
    const parts = [];

    const projectMark = projects.watermark();
    parts.push(`p:${projectMark.n}:${projectMark.at}`);

    const deployMark = deployments.watermark();
    parts.push(`d:${deployMark.last}:${deployMark.running}`);

    for (const run of deploy.active()) parts.push(`a:${run.project}:${run.id}`);

    parts.push(`g:${groups.list().length}`);

    // A daemon that is down is itself a change worth showing.
    const health = await docker.health();
    parts.push(`h:${health.ok ? health.version : "down"}`);

    if (health.ok) {
        const containers = await docker.list({ withStats: false });
        for (const container of containers) {
            parts.push(`c:${container.name}:${container.state}:${container.health || ""}`);
        }
    }

    return crypto.createHash("sha1").update(parts.join("|")).digest("base64url").slice(0, 16);
}

router.get("/pulse", async (req, res) => {
    res.set("Cache-Control", "no-store").json({ v: await fingerprint() });
});

module.exports = router;
