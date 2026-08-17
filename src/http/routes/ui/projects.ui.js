const path = require("node:path");
const express = require("express");

const { PROJECTS_DIR } = require("../../../config");
const projects = require("../../../db/projects.repo");
const deployments = require("../../../db/deployments.repo");
const { groups } = require("../../../db/groups.repo");
const { audit, webhookEvents } = require("../../../db/audit.repo");
const deploy = require("../../../services/deploy.service");
const fleet = require("../../../services/fleet.service");
const v = require("../../../lib/validate");
const giturl = require("../../../lib/giturl");
const envfile = require("../../../lib/envfile");
const projectEnv = require("../../../db/env.repo");
const { sameOrigin } = require("../../middleware/auth");
const { safeBack } = require("../../middleware/locals");

const router = express.Router();

const encode = encodeURIComponent;

const reject = (res, heading, body, status = 400) => res.status(status).render("pages/message", {
    title: "Rejected", nav: "projects", tone: "warn", heading, body,
    action: { href: "/ui/projects", label: "Back to projects" },
});

// ---------------------------------------------------------------- list

router.get("/", (req, res) => {
    const active = deploy.active();
    const rows = projects.listWithLast().map((project) => ({
        ...project,
        history: deployments.recentStatuses(project.id, 12),
    }));

    const search = v.text(req.query.q).toLowerCase();
    const groupBy = v.oneOf(req.query.group, ["group", "status", "none"], "group");

    const filtered = search
        ? rows.filter((project) => [project.name, project.branch, project.path, project.description, project.group?.name]
            .some((field) => field && String(field).toLowerCase().includes(search)))
        : rows;

    res.render("pages/projects", {
        title: "Projects",
        nav: "projects",
        projects: filtered,
        total: rows.length,
        buckets: bucketProjects(filtered, groupBy),
        groupBy,
        search: v.text(req.query.q),
        groups: groups.list(),
        active,
        activeNames: active.map((item) => item.project),
        projectsDir: PROJECTS_DIR,
    });
});

// Projects group by the operator's own grouping or by how the last deploy went;
// anything more specific belongs on the fleet page.
function bucketProjects(rows, groupBy) {
    if (groupBy === "none") return [{ key: "all", title: "All projects", projects: rows }];

    const buckets = new Map();

    for (const project of rows) {
        const key = groupBy === "group"
            ? (project.group ? `g:${project.group.id}` : `${fleet.LOOSE}ungrouped`)
            : (project.last_status || "never");

        if (!buckets.has(key)) {
            buckets.set(key, {
                key,
                title: groupBy === "group"
                    ? (project.group ? project.group.name : "Ungrouped")
                    : titleFor(project.last_status),
                color: project.group?.color || null,
                group: groupBy === "group" ? project.group : null,
                projects: [],
            });
        }

        buckets.get(key).projects.push(project);
    }

    // The bucket with no group behind it sorts last, whatever it is called.
    return [...buckets.values()].sort((a, b) => {
        const aLoose = a.key.startsWith(fleet.LOOSE);
        const bLoose = b.key.startsWith(fleet.LOOSE);
        if (aLoose !== bLoose) return aLoose ? 1 : -1;
        return a.title.localeCompare(b.title);
    });
}

/**
 * The environment editor posts one `env_key` / `env_value` per row, and
 * optionally a whole .env pasted into a textarea. Both end up as the same
 * ordered list; the pasted text wins on a clash, because pasting is the more
 * deliberate act.
 */
function readEnv(body) {
    const keys = [].concat(body?.env_key || []);
    const values = [].concat(body?.env_value || []);

    const pairs = [];

    keys.forEach((key, index) => {
        const name = String(key ?? "").trim();
        // An empty row is an unused row, not an error - the editor always has
        // a spare one at the bottom.
        if (!name) return;
        pairs.push({ key: name, value: String(values[index] ?? "") });
    });

    const pasted = v.text(body?.env_text);

    if (pasted) {
        const { pairs: parsed, problems } = envfile.parse(pasted);

        if (problems.length > 0) {
            throw new v.ValidationError(`That .env could not be read — ${problems[0]}`, "env_text");
        }

        for (const pair of parsed) {
            const existing = pairs.findIndex((row) => row.key === pair.key);
            if (existing === -1) pairs.push(pair);
            else pairs[existing] = pair;
        }
    }

    return envfile.checkAll(pairs);
}

const titleFor = (status) => ({
    failed: "Last deploy failed",
    success: "Healthy",
    running: "Deploying now",
    cancelled: "Last deploy cancelled",
}[status] || "Never deployed");

// ---------------------------------------------------------------- create

/**
 * Registering a project is: a repository URL, where to put it, which branch,
 * and which group. Everything else follows from those - the name comes from the
 * URL, the checkout path from the name, and the checkout itself from the first
 * deploy, which clones it and brings the stack up.
 */
router.post("/", sameOrigin, (req, res, next) => {
    const url = v.text(req.body?.repo_url);

    // Registering by hand, without a URL, stays possible: that is the case
    // where the checkout is already on disk.
    let name = v.text(req.body?.name);
    let repoUrl = null;

    if (url) {
        let parsed;
        try {
            parsed = giturl.parse(url);
        } catch (err) {
            return next(err);
        }

        repoUrl = parsed.url;
        // An explicit name would break the webhook, which matches on the name
        // GitHub sends - and that is the one in the URL.
        name = parsed.name;
    }

    if (!v.PROJECT_NAME.test(name)) {
        return reject(res, "That project name will not work",
            "Letters, digits, dot, dash and underscore only — it has to match the repository name exactly.");
    }

    if (projects.byName(name)) return res.redirect(`/ui/projects/${encode(name)}?msg=exists`);

    // The operator gives a directory to put projects in, not a path per
    // project: /srv/projects plus the name is the checkout.
    const parent = v.text(req.body?.path) || PROJECTS_DIR;
    if (!path.isAbsolute(parent)) {
        return reject(res, "The checkout directory must be absolute", parent);
    }

    // Tolerates being handed either the parent or the full checkout path, since
    // both are reasonable things to paste.
    const checkout = path.basename(parent) === name ? parent : path.join(parent, name);

    const branch = v.text(req.body?.branch) || "main";
    if (!v.BRANCH_NAME.test(branch)) return reject(res, "That branch name will not work", branch);

    // Parsed before the project exists, so a bad variable name is a rejected
    // form rather than a half-registered project.
    let variables;
    try {
        variables = readEnv(req.body);
    } catch (err) {
        return next(err);
    }

    const project = projects.create({
        name,
        branch,
        path: checkout,
        repo_url: repoUrl,
        description: v.text(req.body?.description) || null,
        group_id: v.integer(req.body?.group_id, null) || null,
    });

    if (variables.length > 0) projectEnv.replace(project.id, variables);

    audit.record({
        action: "project.create",
        target: name,
        detail: `${repoUrl ? giturl.redact(repoUrl) : checkout}${variables.length ? ` · ${variables.length} env vars` : ""}`,
        actor: "ui",
        ip: req.ip,
    });

    // Nothing to wait for: the run clones, builds and starts, and its log is
    // already streaming by the time the page loads.
    if (repoUrl) {
        deploy.schedule(project, { branch, trigger: "manual", actor: "ui" });
        return res.redirect(`/ui/projects/${encode(name)}?msg=cloning`);
    }

    res.redirect(`/ui/projects/${encode(name)}?msg=created`);
});

// ---------------------------------------------------------------- detail

router.get("/:name", async (req, res, next) => {
    const project = projects.byName(req.params.name);
    if (!project) return next();

    const active = deploy.active().find((item) => item.project === project.name) || null;
    const containers = await fleet.forProject(project).catch((err) => ({ ok: false, error: err.message, containers: [] }));

    res.render("pages/project", {
        title: project.name,
        nav: "projects",
        project,
        // The checkout may not exist yet: a project registered by URL is only
        // cloned when its first deploy runs.
        pending: deploy.needsClone(project),
        repoUrl: giturl.redact(project.repo_url),
        env: projectEnv.list(project.id),
        isSecret: envfile.isSecret,
        active,
        containers,
        groups: groups.list(),
        history: deployments.list({ project: project.name, limit: 30 }),
        sparkline: deployments.recentStatuses(project.id, 20),
        delivery: webhookEvents.lastFor(project.name),
        plan: deploy.buildPlan(project, project.branch),
        projectsDir: PROJECTS_DIR,
    });
});

// ---------------------------------------------------------------- actions

router.post("/:name/deploy", sameOrigin, (req, res, next) => {
    const project = projects.byName(req.params.name);
    if (!project) return next();

    const branch = v.text(req.body?.branch) || project.branch;
    if (!v.BRANCH_NAME.test(branch)) return reject(res, "That branch name will not work", branch);

    const state = deploy.schedule(project, { branch, trigger: "manual", actor: "ui" });
    audit.record({ action: "project.deploy", target: project.name, detail: branch, actor: "ui", ip: req.ip });

    const target = safeBack(req.body?.back, "/ui/projects");
    res.redirect(`${target}?msg=${state === "queued" ? "queued" : "deployed"}`);
});

router.post("/:name/cancel", sameOrigin, (req, res) => {
    deploy.cancel(req.params.name);
    audit.record({ action: "project.cancel", target: req.params.name, actor: "ui", ip: req.ip });

    res.redirect(`${safeBack(req.body?.back, "/ui/projects")}?msg=cancelled`);
});

router.post("/:name/settings", sameOrigin, (req, res, next) => {
    const project = projects.byName(req.params.name);
    if (!project) return next();

    const branch = v.text(req.body?.branch) || project.branch;
    if (!v.BRANCH_NAME.test(branch)) return reject(res, "That branch name will not work", branch);

    const stack = v.optional(req.body?.stack, "stack", v.STACK_NAME,
        "A compose project name uses letters, digits, dot, dash and underscore.");

    // Clearing the field is how you say "this checkout is managed by hand".
    const rawUrl = v.text(req.body?.repo_url);
    let repoUrl = null;

    if (rawUrl) {
        try {
            repoUrl = giturl.parse(rawUrl).url;
        } catch (err) {
            return next(err);
        }
    }

    projects.update(project.name, {
        repo_url: repoUrl,
        branch,
        compose_file: v.text(req.body?.compose_file) || null,
        description: v.text(req.body?.description) || null,
        stack,
        group_id: v.integer(req.body?.group_id, null) || null,
        // A checkbox is absent from the body when unticked, which is exactly
        // the false case.
        enabled: v.checkbox(req.body?.enabled),
        auto_deploy: v.checkbox(req.body?.auto_deploy),
        prune_images: v.checkbox(req.body?.prune_images),
        clean_untracked: v.checkbox(req.body?.clean_untracked),
        pinned: v.checkbox(req.body?.pinned),
    });

    audit.record({ action: "project.update", target: project.name, actor: "ui", ip: req.ip });
    res.redirect(`/ui/projects/${encode(project.name)}?msg=saved`);
});

/**
 * Replaces a project's environment. Takes effect on the next deploy, which is
 * when the file is written — so the form offers to run one straight away.
 */
router.post("/:name/env", sameOrigin, (req, res, next) => {
    const project = projects.byName(req.params.name);
    if (!project) return next();

    let variables;
    try {
        variables = readEnv(req.body);
    } catch (err) {
        return next(err);
    }

    projectEnv.replace(project.id, variables);

    audit.record({
        action: "project.env",
        target: project.name,
        // Names only. The values are the reason this table exists.
        detail: variables.map((pair) => pair.key).join(", ") || "(cleared)",
        actor: "ui",
        ip: req.ip,
    });

    if (v.checkbox(req.body?.deploy_now) && project.enabled) {
        const state = deploy.schedule(project, { branch: project.branch, trigger: "manual", actor: "ui" });
        return res.redirect(`/ui/projects/${encode(project.name)}?msg=${state === "queued" ? "queued" : "deployed"}`);
    }

    res.redirect(`/ui/projects/${encode(project.name)}?msg=env-saved`);
});

router.post("/:name/delete", sameOrigin, (req, res) => {
    // Only the registry row goes; whatever the project deployed keeps running,
    // which is the safe half of "remove this from Nimbus2k".
    projects.remove(req.params.name);
    audit.record({ action: "project.delete", target: req.params.name, actor: "ui", ip: req.ip });

    res.redirect("/ui/projects?msg=deleted");
});

module.exports = router;
