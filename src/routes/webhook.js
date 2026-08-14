const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const { PROJECTS_DIR, SECRET, AUTO_REGISTER } = require("../config");
const { repos } = require("../db");
const { schedule } = require("../deployer");
const { equals } = require("../auth");
const { REPO_NAME } = require("../validate");

const router = express.Router();

function verifySignature(req) {
    const header = req.get("X-Hub-Signature-256");
    if (!header || !req.rawBody) return false;

    const expected = "sha256=" +
        crypto.createHmac("sha256", SECRET).update(req.rawBody).digest("hex");

    return equals(header, expected);
}

router.post("/webhook", (req, res) => {
    if (!verifySignature(req)) return res.status(401).send("Invalid signature");

    const event = req.get("X-GitHub-Event");
    if (event === "ping") return res.send("pong");
    if (event !== "push") return res.send("Ignored: not a push");

    const name = req.body?.repository?.name;
    const ref = req.body?.ref;

    if (typeof name !== "string" || typeof ref !== "string") {
        return res.status(400).send("Malformed payload");
    }

    if (req.body.deleted) return res.send("Ignored: branch deleted");
    if (!ref.startsWith("refs/heads/")) return res.send("Ignored: not a branch");

    // Guards the filesystem path we build from the payload.
    if (!REPO_NAME.test(name)) {
        console.warn(`rejected repository name: ${JSON.stringify(name)}`);
        return res.status(400).send("Invalid repository name");
    }

    const branch = ref.slice("refs/heads/".length);
    let repo = repos.byName(name);

    if (!repo) {
        const repoPath = path.join(PROJECTS_DIR, name);

        if (!AUTO_REGISTER || !fs.existsSync(path.join(repoPath, ".git"))) {
            return res.status(404).send("Repository not registered");
        }

        repo = repos.create({ name, branch, path: repoPath });
        console.log(`auto-registered ${name} (${branch}) at ${repoPath}`);
    }

    if (!repo.enabled) return res.send("Ignored: repository disabled");
    if (branch !== repo.branch) return res.send(`Ignored: branch ${branch}`);

    const state = schedule(repo, { branch, commitSha: req.body.after || null });
    res.status(202).json({ repo: name, branch, state });
});

module.exports = router;
