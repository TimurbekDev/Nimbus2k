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

const titleFor = (status) => ({
    failed: "Last deploy failed",
    success: "Healthy",
    running: "Deploying now",
    cancelled: "Last deploy cancelled",
}[status] || "Never deployed");

// ---------------------------------------------------------------- create

router.post("/", sameOrigin, (req, res) => {
    const name = v.text(req.body?.name);

    if (!v.PROJECT_NAME.test(name)) {
        return reject(res, "That project name will not work",
            "Letters, digits, dot, dash and underscore only — it has to match the GitHub repository name exactly.");
    }

    if (projects.byName(name)) return res.redirect(`/ui/projects/${encode(name)}`);

    const checkout = v.text(req.body?.path) || path.join(PROJECTS_DIR, name);
    if (!path.isAbsolute(checkout)) {
        return reject(res, "The checkout path must be absolute", checkout);
    }

    const groupId = v.integer(req.body?.group_id, null) || null;

    projects.create({
        name,
        branch: v.text(req.body?.branch) || "main",
        path: checkout,
        description: v.text(req.body?.description) || null,
        group_id: groupId,
    });

    audit.record({ action: "project.create", target: name, actor: "ui", ip: req.ip });
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

    projects.update(project.name, {
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

router.post("/:name/delete", sameOrigin, (req, res) => {
    // Only the registry row goes; whatever the project deployed keeps running,
    // which is the safe half of "remove this from Nimbus2k".
    projects.remove(req.params.name);
    audit.record({ action: "project.delete", target: req.params.name, actor: "ui", ip: req.ip });

    res.redirect("/ui/projects?msg=deleted");
});

module.exports = router;
