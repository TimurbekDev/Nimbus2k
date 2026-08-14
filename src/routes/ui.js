const express = require("express");

const { ADMIN_TOKEN } = require("./config");
const { repos, deployments } = require("./db");
const { schedule, running } = require("./deployer");
const {
    validToken, createSession, validSession, destroySession,
    throttled, recordFailure, clearFailures, readCookie, SESSION_TTL_MS,
} = require("./auth");

const REPO_NAME = /^[A-Za-z0-9._-]+$/;

// sqlite writes `datetime('now')`, which is UTC without a marker; parsed as-is
// a browser in UTC+5 would read every timestamp five hours early.
const parseTime = (value) => (value ? new Date(`${value.replace(" ", "T")}Z`) : null);

const fmt = {
    ago(value) {
        const date = parseTime(value);
        if (!date) return "-";

        const seconds = Math.round((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
    },

    stamp(value) {
        const date = parseTime(value);
        return date ? date.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "-";
    },

    duration(ms) {
        if (ms === null || ms === undefined) return "-";
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
    },

    sha: (value) => (value ? value.slice(0, 7) : "-"),
};

const router = express.Router();

// Only the UI parses form bodies; the webhook stays on the JSON parser that
// captures rawBody for the HMAC check.
router.use(express.urlencoded({ extended: false }));

router.use((req, res, next) => {
    res.locals.fmt = fmt;
    res.locals.path = req.path;
    next();
});

// SameSite=Strict already stops a cross-site form from carrying the session
// cookie; rejecting a mismatched Origin covers the rest.
function sameOrigin(req, res, next) {
    const origin = req.get("Origin");
    if (!origin) return next();

    let host;
    try {
        host = new URL(origin).host;
    } catch {
        return res.status(403).send("Bad Origin");
    }

    if (host !== req.get("Host")) return res.status(403).send("Bad Origin");
    next();
}

function requireSession(req, res, next) {
    if (!ADMIN_TOKEN) {
        return res.status(503).render("message", {
            title: "Not configured",
            heading: "ADMIN_TOKEN is not configured",
            body: "Set ADMIN_TOKEN in .env and restart the server.",
        });
    }

    const sid = readCookie(req, "sid");
    if (sid && validSession(sid)) {
        req.sid = sid;
        return next();
    }

    res.redirect("/ui/login");
}

// ---------------------------------------------------------------- login

router.get("/login", (req, res) => {
    const sid = readCookie(req, "sid");
    if (sid && validSession(sid)) return res.redirect("/ui");

    res.render("login", { error: null, configured: Boolean(ADMIN_TOKEN) });
});

router.post("/login", sameOrigin, (req, res) => {
    const fail = (error, status = 401) =>
        res.status(status).render("login", { error, configured: Boolean(ADMIN_TOKEN) });

    if (!ADMIN_TOKEN) return fail("ADMIN_TOKEN is not configured on the server", 503);
    if (throttled(req.ip)) return fail("Too many attempts. Try again in 15 minutes.", 429);

    if (!validToken(req.body?.token || "")) {
        recordFailure(req.ip);
        return fail("Wrong token");
    }

    clearFailures(req.ip);

    res.cookie("sid", createSession(), {
        httpOnly: true,
        sameSite: "strict",
        // Behind the nginx proxy this is decided by X-Forwarded-Proto, so a
        // plain-HTTP dev run still gets a usable cookie.
        secure: req.secure,
        maxAge: SESSION_TTL_MS,
        path: "/ui",
    });

    res.redirect("/ui");
});

router.post("/logout", sameOrigin, (req, res) => {
    const sid = readCookie(req, "sid");
    if (sid) destroySession(sid);

    res.clearCookie("sid", { path: "/ui" });
    res.redirect("/ui/login");
});

// ---------------------------------------------------------------- dashboard

router.use(requireSession);

router.get("/", (req, res) => {
    res.render("dashboard", {
        title: "deploy-server",
        running: running(),
        repos: repos.list(),
        recent: deployments.list({ limit: 20 }),
    });
});

router.get("/repos/:name", (req, res) => {
    const repo = repos.byName(req.params.name);
    if (!repo) return res.status(404).render("message", {
        title: "Not found",
        heading: "No such repository",
        body: req.params.name,
    });

    res.render("repo", {
        title: repo.name,
        repo,
        running: running().includes(repo.name),
        history: deployments.list({ repo: repo.name, limit: 50 }),
    });
});

router.post("/repos/:name/deploy", sameOrigin, (req, res) => {
    const repo = repos.byName(req.params.name);
    if (!repo) return res.redirect("/ui");

    schedule(repo, { branch: req.body?.branch || repo.branch, source: "manual" });

    // Whitelisted rather than echoed back: an arbitrary value here would turn
    // the form into an open redirect.
    const back = req.body?.back;
    res.redirect(typeof back === "string" && back.startsWith("/ui") ? back : "/ui");
});

router.post("/repos/:name/settings", sameOrigin, (req, res) => {
    const repo = repos.byName(req.params.name);
    if (!repo) return res.redirect("/ui");

    const branch = req.body?.branch || repo.branch;
    if (!REPO_NAME.test(branch.replace(/\//g, "-"))) {
        return res.status(400).render("message", {
            title: "Invalid branch",
            heading: "Invalid branch name",
            body: branch,
        });
    }

    // Checkboxes are absent from the body when unticked, which is exactly the
    // false case; a missing text field means "leave it alone".
    repos.update(repo.name, {
        branch,
        compose_file: req.body?.compose_file?.trim() || null,
        enabled: Boolean(req.body?.enabled),
        prune_images: Boolean(req.body?.prune_images),
        clean_untracked: Boolean(req.body?.clean_untracked),
    });

    res.redirect(`/ui/repos/${encodeURIComponent(repo.name)}`);
});

router.get("/deployments/:id", (req, res) => {
    const deployment = deployments.get(Number(req.params.id));
    if (!deployment) return res.status(404).render("message", {
        title: "Not found",
        heading: "No such deployment",
        body: `#${req.params.id}`,
    });

    res.render("deployment", { title: `#${deployment.id} ${deployment.repo}`, deployment });
});

module.exports = router;
