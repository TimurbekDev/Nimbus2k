const os = require("node:os");
const express = require("express");

const config = require("../../../config");
const docker = require("../../../services/docker.service");
const fleet = require("../../../services/fleet.service");
const { audit, webhookEvents } = require("../../../db/audit.repo");
const { sessionCount } = require("../../../services/auth.service");
const projects = require("../../../db/projects.repo");
const deployments = require("../../../db/deployments.repo");
const v = require("../../../lib/validate");
const { sameOrigin } = require("../../middleware/auth");

const router = express.Router();

// Values, not secrets: everything shown here is either public or a shape
// ("set", "24 characters") rather than the secret itself.
const settingsView = () => [
    { key: "PROJECTS_DIR", value: config.PROJECTS_DIR, note: "where checkouts live" },
    { key: "DB_PATH", value: config.DB_PATH, note: "registry and deploy history" },
    { key: "HOST:PORT", value: `${config.HOST}:${config.PORT}`, note: "bind address" },
    { key: "AUTO_REGISTER", value: String(config.AUTO_REGISTER), note: "a push from an unknown repo registers itself" },
    { key: "STEP_TIMEOUT_MS", value: String(config.STEP_TIMEOUT_MS), note: "a step running longer than this is killed" },
    { key: "DEPLOYMENT_HISTORY", value: String(config.DEPLOYMENT_HISTORY), note: "runs kept per project" },
    { key: "LOG_TAIL_BYTES", value: String(config.LOG_TAIL_BYTES), note: "log kept per run" },
    { key: "CONTAINER_ACTIONS", value: String(config.CONTAINER_ACTIONS), note: "start / stop / restart from the UI" },
    { key: "CONTAINER_DESTRUCTIVE_ACTIONS", value: String(config.CONTAINER_DESTRUCTIVE_ACTIONS), note: "kill, remove and prune" },
    { key: "ADMIN_USER", value: config.ADMIN_USER, note: "the operator who signs in" },
    {
        key: "ADMIN_PASSWORD",
        value: "scrypt digest",
        note: config.PASSWORD_FROM_ENV
            ? "hashed from .env — that line can now be deleted"
            : "generated on first run, stored hashed",
    },
    {
        key: "ADMIN_TOKEN",
        value: config.ADMIN_TOKEN ? `set · ${config.ADMIN_TOKEN.length} characters` : "not set — API uses Basic auth",
        note: "bearer token for machines",
    },
];

// The example on the page should be one an operator can paste as-is, which
// depends on whether a bearer token exists at all.
const apiExample = () => (config.ADMIN_TOKEN
    ? `curl -H "Authorization: Bearer $ADMIN_TOKEN" \\\n     http://${config.HOST}:${config.PORT}/api/v1/status`
    : `curl -u '${config.ADMIN_USER}:$ADMIN_PASSWORD' \\\n     http://${config.HOST}:${config.PORT}/api/v1/status`);

router.get("/", async (req, res) => {
    const [health, usage, info, unmanaged] = await Promise.all([
        docker.health(),
        docker.systemUsage(),
        docker.daemonInfo(),
        fleet.unmanagedStacks().catch(() => []),
    ]);

    res.render("pages/settings", {
        title: "Settings",
        nav: "settings",
        settings: settingsView(),
        apiExample: apiExample(),
        // Shown so a generated secret can be copied into GitHub; there is
        // nowhere else to read it from.
        webhook: { secret: config.SECRET, generated: config.SECRET_GENERATED },
        health,
        usage,
        info,
        unmanaged,
        audit: audit.list({ limit: 40 }),
        deliveries: webhookEvents.list({ limit: 20 }),
        runtime: {
            node: process.version,
            uptimeMs: Math.round(process.uptime() * 1000),
            memoryMb: Math.round(process.memoryUsage().rss / 1048576),
            host: os.hostname(),
            platform: `${os.type()} ${os.release()}`,
            cpus: os.cpus().length,
            sessions: sessionCount(),
            projects: projects.count(),
            deployments: deployments.stats().total,
        },
    });
});

router.post("/prune", sameOrigin, async (req, res, next) => {
    const target = v.text(req.body?.target);

    try {
        const result = await docker.prune(target);
        audit.record({ action: "system.prune", target, detail: result.reclaimed, actor: "ui", ip: req.ip });
        return res.redirect("/ui/settings?msg=pruned");
    } catch (err) {
        audit.record({ action: "system.prune", target, detail: err.message, actor: "ui", ip: req.ip, ok: false });
        return next(err);
    }
});

module.exports = router;
