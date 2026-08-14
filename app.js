const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const { PORT, HOST, PROJECTS_DIR, SECRET, AUTO_REGISTER } = require("./config");
const { repos, deployments } = require("./db");
const { schedule, running } = require("./deployer");
const { equals, requireAdmin } = require("./auth");
const ui = require("./ui");

const REPO_NAME = /^[A-Za-z0-9._-]+$/;

function verifySignature(req) {
    const header = req.get("X-Hub-Signature-256");
    if (!header || !req.rawBody) return false;

    const expected = "sha256=" +
        crypto.createHmac("sha256", SECRET).update(req.rawBody).digest("hex");

    return equals(header, expected);
}

const app = express();

// One reverse proxy sits in front, so req.ip and req.secure should follow its
// X-Forwarded-* headers rather than describing the loopback hop.
app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.json({
    limit: "1mb",
    verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Stylesheet only, and the login page needs it before there is a session.
app.use("/assets", express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.get("/", (req, res) => res.redirect("/ui"));
app.use("/ui", ui);

// ---------------------------------------------------------------- webhook

app.post("/webhook", (req, res) => {
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

// ---------------------------------------------------------------- admin

app.use("/repos", requireAdmin);
app.use("/deployments", requireAdmin);
app.use("/status", requireAdmin);

app.get("/status", (req, res) => res.json({
    running: running(),
    repos: repos.list().length,
    recent: deployments.list({ limit: 10 }),
}));

app.get("/repos", (req, res) => res.json(repos.list()));

app.post("/repos", (req, res) => {
    const { name, branch = "master", path: repoPath, ...rest } = req.body || {};

    if (typeof name !== "string" || !REPO_NAME.test(name)) {
        return res.status(400).json({ error: "Invalid repository name" });
    }

    if (repos.byName(name)) return res.status(409).json({ error: "Already registered" });

    const target = repoPath || path.join(PROJECTS_DIR, name);
    if (!path.isAbsolute(target)) return res.status(400).json({ error: "path must be absolute" });

    res.status(201).json(repos.create({ name, branch, path: target, ...rest }));
});

app.patch("/repos/:name", (req, res) => {
    if (!repos.byName(req.params.name)) return res.status(404).json({ error: "Not found" });
    res.json(repos.update(req.params.name, req.body || {}));
});

app.delete("/repos/:name", (req, res) => {
    if (!repos.remove(req.params.name)) return res.status(404).json({ error: "Not found" });
    res.status(204).end();
});

app.post("/repos/:name/deploy", (req, res) => {
    const repo = repos.byName(req.params.name);
    if (!repo) return res.status(404).json({ error: "Not found" });

    const branch = req.body?.branch || repo.branch;
    const state = schedule(repo, { branch, source: "manual" });

    res.status(202).json({ repo: repo.name, branch, state });
});

app.get("/deployments", (req, res) => res.json(deployments.list({
    repo: req.query.repo || null,
    limit: Math.min(Number(req.query.limit) || 20, 100),
})));

app.get("/deployments/:id", (req, res) => {
    const deployment = deployments.get(Number(req.params.id));
    if (!deployment) return res.status(404).json({ error: "Not found" });
    res.json(deployment);
});

// ---------------------------------------------------------------- boot

const server = app.listen(PORT, HOST, () =>
    console.log(`deploy-server listening on ${HOST}:${PORT}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
}
