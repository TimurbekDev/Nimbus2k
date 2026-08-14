const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const { PROJECTS_DIR, SECRET, AUTO_REGISTER } = require("../../config");
const projects = require("../../db/projects.repo");
const { webhookEvents } = require("../../db/audit.repo");
const deploy = require("../../services/deploy.service");
const { equals } = require("../../services/auth.service");
const { PROJECT_NAME } = require("../../lib/validate");
const logger = require("../../lib/logger");

const log = logger("webhook");
const router = express.Router();

function verifySignature(req) {
    const header = req.get("X-Hub-Signature-256");
    if (!header || !req.rawBody) return false;

    const expected = `sha256=${crypto.createHmac("sha256", SECRET).update(req.rawBody).digest("hex")}`;

    return equals(header, expected);
}

// Recorded even when nothing happens: "I pushed and nothing deployed" is the
// most common question this endpoint has to answer, and the delivery log is
// the only place it can be answered from.
const ignore = (res, fields, reason) => {
    webhookEvents.record({ ...fields, outcome: "ignored", detail: reason });
    return res.send(`Ignored: ${reason}`);
};

router.post("/webhook", (req, res) => {
    if (!verifySignature(req)) {
        webhookEvents.record({ event: "unknown", outcome: "rejected", detail: "invalid signature" });
        log.warn("rejected delivery", { ip: req.ip, reason: "invalid signature" });
        return res.status(401).send("Invalid signature");
    }

    const event = req.get("X-GitHub-Event") || "unknown";

    if (event === "ping") {
        webhookEvents.record({ event, outcome: "ok", detail: "ping" });
        return res.send("pong");
    }

    if (event !== "push") return ignore(res, { event }, "not a push");

    const name = req.body?.repository?.name;
    const ref = req.body?.ref;

    if (typeof name !== "string" || typeof ref !== "string") {
        webhookEvents.record({ event, outcome: "rejected", detail: "malformed payload" });
        return res.status(400).send("Malformed payload");
    }

    const commitSha = req.body.after || null;

    if (req.body.deleted) return ignore(res, { event, repo: name, commitSha }, "branch deleted");
    if (!ref.startsWith("refs/heads/")) return ignore(res, { event, repo: name, commitSha }, "not a branch");

    // Guards the filesystem path built from the payload.
    if (!PROJECT_NAME.test(name)) {
        webhookEvents.record({ event, outcome: "rejected", detail: "invalid repository name" });
        log.warn("rejected repository name", { name });
        return res.status(400).send("Invalid repository name");
    }

    const branch = ref.slice("refs/heads/".length);
    const fields = { event, repo: name, branch, commitSha };

    let project = projects.byName(name);

    if (!project) {
        const checkout = path.join(PROJECTS_DIR, name);

        if (!AUTO_REGISTER || !fs.existsSync(path.join(checkout, ".git"))) {
            webhookEvents.record({ ...fields, outcome: "rejected", detail: "project not registered" });
            return res.status(404).send("Repository not registered");
        }

        project = projects.create({ name, branch, path: checkout });
        log.info("auto-registered project", { name, branch, path: checkout });
    }

    if (!project.enabled) return ignore(res, fields, "project disabled");
    if (!project.auto_deploy) return ignore(res, fields, "auto-deploy off");
    if (branch !== project.branch) return ignore(res, fields, `branch ${branch} is not ${project.branch}`);

    const state = deploy.schedule(project, { branch, commitSha, trigger: "webhook" });
    webhookEvents.record({ ...fields, outcome: state, detail: req.body.head_commit?.message?.split("\n")[0] || null });

    res.status(202).json({ project: name, branch, state });
});

module.exports = router;
