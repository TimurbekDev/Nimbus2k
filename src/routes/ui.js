const path = require("node:path");
const express = require("express");

const { ADMIN_TOKEN, PROJECTS_DIR } = require("../config");
const { repos, deployments } = require("../db");
const { schedule, cancel, runningInfo, liveLog, events } = require("../deployer");
const fmt = require("../format");
const { REPO_NAME, BRANCH_NAME } = require("../validate");
const {
    validToken, createSession, validSession, destroySession,
    throttled, recordFailure, clearFailures, readCookie, SESSION_TTL_MS,
} = require("../auth");

// Flash messages travel in the query string, so only these keys are ever
// turned into text: whatever a link carries can never become page content.
const FLASH = {
    deployed: "Deploy started.",
    queued: "A deploy is already running; this one is queued.",
    cancelled: "Deploy cancelled.",
    saved: "Settings saved.",
    created: "Repository registered.",
};

const router = express.Router();

// Only the UI parses form bodies; the webhook stays on the JSON parser that
// captures rawBody for the HMAC check.
router.use(express.urlencoded({ extended: false }));

router.use((req, res, next) => {
    res.locals.fmt = fmt;
    res.locals.flash = FLASH[req.query.msg] || null;
    res.locals.session = true;
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

const notFound = (res, heading, body) => res.status(404).render("message", {
    title: "Not found", heading, body,
});

// ---------------------------------------------------------------- login

router.get("/login", (req, res) => {
    const sid = readCookie(req, "sid");
    if (sid && validSession(sid)) return res.redirect("/ui");

    res.render("login", { title: "Log in", error: null, configured: Boolean(ADMIN_TOKEN), session: false });
});

router.post("/login", sameOrigin, (req, res) => {
    const fail = (error, status = 401) => res.status(status).render("login", {
        title: "Log in", error, configured: Boolean(ADMIN_TOKEN), session: false,
    });

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

// ---------------------------------------------------------------- live feed

router.use(requireSession);

// Server-sent events rather than polling: a deploy produces output in bursts,
// and every open tab should see a line the moment it is written.
router.get("/events", (req, res) => {
    res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // nginx buffers a proxied response by default, which would hold every
        // line back until the deploy finished.
        "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write(": connected\n\n");

    const onEvent = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    events.on("event", onEvent);

    // Also keeps the proxy from closing an idle connection at proxy_read_timeout.
    const beat = setInterval(() => res.write(": ping\n\n"), 25000);

    req.on("close", () => {
        clearInterval(beat);
        events.off("event", onEvent);
    });
});

// ---------------------------------------------------------------- dashboard

router.get("/", (req, res) => {
    const active = runningInfo();

    res.render("dashboard", {
        title: "Dashboard",
        active,
        activeNames: active.map((item) => item.repo),
        repos: repos.listWithLast(),
        recent: deployments.list({ limit: 20 }),
        stats: deployments.stats(),
        projectsDir: PROJECTS_DIR,
    });
});

router.post("/repos", sameOrigin, (req, res) => {
    const name = (req.body?.name || "").trim();
    const branch = (req.body?.branch || "").trim() || "main";

    if (!REPO_NAME.test(name)) {
        return res.status(400).render("message", {
            title: "Invalid name",
            heading: "Invalid repository name",
            body: "Letters, digits, dot, dash and underscore only - it has to match the GitHub repository name.",
        });
    }

    if (repos.byName(name)) return res.redirect(`/ui/repos/${encodeURIComponent(name)}`);

    const target = (req.body?.path || "").trim() || path.join(PROJECTS_DIR, name);
    if (!path.isAbsolute(target)) {
        return res.status(400).render("message", {
            title: "Invalid path",
            heading: "The checkout path must be absolute",
            body: target,
        });
    }

    repos.create({ name, branch, path: target });
    res.redirect(`/ui/repos/${encodeURIComponent(name)}?msg=created`);
});

// ---------------------------------------------------------------- repository

router.get("/repos/:name", (req, res) => {
    const repo = repos.byName(req.params.name);
    if (!repo) return notFound(res, "No such repository", req.params.name);

    const active = runningInfo().find((item) => item.repo === repo.name) || null;

    res.render("repo", {
        title: repo.name,
        repo,
        active,
        history: deployments.list({ repo: repo.name, limit: 50 }),
    });
});

router.post("/repos/:name/deploy", sameOrigin, (req, res) => {
    const repo = repos.byName(req.params.name);
    if (!repo) return res.redirect("/ui");

    const branch = (req.body?.branch || "").trim() || repo.branch;
    if (!BRANCH_NAME.test(branch)) {
        return res.status(400).render("message", {
            title: "Invalid branch", heading: "Invalid branch name", body: branch,
        });
    }

    const state = schedule(repo, { branch, source: "manual" });

    // Whitelisted rather than echoed back: an arbitrary value here would turn
    // the form into an open redirect.
    const back = req.body?.back;
    const target = typeof back === "string" && back.startsWith("/ui") ? back : "/ui";

    res.redirect(`${target}?msg=${state === "queued" ? "queued" : "deployed"}`);
});

router.post("/repos/:name/cancel", sameOrigin, (req, res) => {
    cancel(req.params.name);

    const back = req.body?.back;
    const target = typeof back === "string" && back.startsWith("/ui") ? back : "/ui";

    res.redirect(`${target}?msg=cancelled`);
});

router.post("/repos/:name/settings", sameOrigin, (req, res) => {
    const repo = repos.byName(req.params.name);
    if (!repo) return res.redirect("/ui");

    const branch = (req.body?.branch || "").trim() || repo.branch;
    if (!BRANCH_NAME.test(branch)) {
        return res.status(400).render("message", {
            title: "Invalid branch", heading: "Invalid branch name", body: branch,
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

    res.redirect(`/ui/repos/${encodeURIComponent(repo.name)}?msg=saved`);
});

// ---------------------------------------------------------------- deployment

router.get("/deployments/:id", (req, res) => {
    const id = Number(req.params.id);
    const deployment = deployments.get(id);
    if (!deployment) return notFound(res, "No such deployment", `#${req.params.id}`);

    // A finished run has its log in the database; a running one only exists in
    // the deployer's buffer until it ends.
    const live = deployment.status === "running" ? liveLog(id) : null;

    res.render("deployment", {
        title: `#${deployment.id} ${deployment.repo}`,
        deployment,
        log: live ? live.join("\n") : (deployment.log || ""),
    });
});

router.get("/deployments/:id/raw", (req, res) => {
    const id = Number(req.params.id);
    const deployment = deployments.get(id);
    if (!deployment) return notFound(res, "No such deployment", `#${req.params.id}`);

    const live = deployment.status === "running" ? liveLog(id) : null;

    res.type("text/plain").send(live ? live.join("\n") : (deployment.log || ""));
});

router.post("/deployments/:id/redeploy", sameOrigin, (req, res) => {
    const deployment = deployments.get(Number(req.params.id));
    if (!deployment) return res.redirect("/ui");

    const repo = repos.byName(deployment.repo);
    if (!repo) return res.redirect("/ui");

    const state = schedule(repo, { branch: deployment.branch, source: "manual" });
    const target = `/ui/repos/${encodeURIComponent(repo.name)}`;

    res.redirect(`${target}?msg=${state === "queued" ? "queued" : "deployed"}`);
});

module.exports = router;
