const express = require("express");

const { groups, containerMeta } = require("../../../db/groups.repo");
const projects = require("../../../db/projects.repo");
const { audit } = require("../../../db/audit.repo");
const deploy = require("../../../services/deploy.service");
const fleet = require("../../../services/fleet.service");
const docker = require("../../../services/docker.service");
const v = require("../../../lib/validate");
const { sameOrigin } = require("../../middleware/auth");
const { safeBack } = require("../../middleware/locals");

const router = express.Router();

router.get("/", async (req, res) => {
    const rows = groups.list();
    const view = await fleet.view({ groupBy: "group", sortBy: "state" })
        .catch((err) => ({ ok: false, error: err.message, buckets: [] }));

    // Each group card shows what is inside it, which is a project list from the
    // database and a container list from the daemon.
    const detailed = rows.map((group) => ({
        ...group,
        projects: projects.inGroup(group.id),
        containers: view.ok
            ? (view.buckets.find((bucket) => bucket.group?.id === group.id)?.containers || [])
            : [],
    }));

    res.render("pages/groups", {
        title: "Groups",
        nav: "groups",
        groups: detailed,
        ungroupedProjects: projects.list().filter((project) => !project.group_id),
        ungrouped: view.ok
            ? (view.buckets.find((bucket) => bucket.key === `${fleet.LOOSE}ungrouped`)?.containers || [])
            : [],
        colors: v.GROUP_COLORS,
        dockerOk: view.ok,
        dockerError: view.error || null,
    });
});

router.post("/", sameOrigin, (req, res, next) => {
    const name = v.text(req.body?.name);

    if (!v.GROUP_NAME.test(name)) {
        return next(new v.ValidationError("A group name is 1-48 letters, digits, space, dot, dash or underscore", "name"));
    }

    if (groups.byName(name)) return res.redirect("/ui/groups?msg=grouped");

    const group = groups.create({
        name,
        color: v.oneOf(req.body?.color, v.GROUP_COLORS, "slate"),
        description: v.text(req.body?.description) || null,
    });

    audit.record({ action: "group.create", target: group.name, actor: "ui", ip: req.ip });
    res.redirect("/ui/groups?msg=group-created");
});

router.post("/:id/update", sameOrigin, (req, res, next) => {
    const id = v.integer(req.params.id, null);
    if (!id || !groups.byId(id)) return next();

    const patch = {};

    if (req.body?.name !== undefined) {
        const name = v.text(req.body.name);
        if (!v.GROUP_NAME.test(name)) return next(new v.ValidationError("Invalid group name", "name"));
        patch.name = name;
    }

    if (req.body?.color !== undefined) patch.color = v.oneOf(req.body.color, v.GROUP_COLORS, "slate");
    if (req.body?.description !== undefined) patch.description = v.text(req.body.description) || null;

    groups.update(id, patch);
    audit.record({ action: "group.update", target: String(id), actor: "ui", ip: req.ip });

    res.redirect(`${safeBack(req.body?.back, "/ui/groups")}?msg=saved`);
});

router.post("/:id/delete", sameOrigin, (req, res, next) => {
    const id = v.integer(req.params.id, null);
    if (!id) return next();

    // Members are detached, not deleted: the foreign keys are ON DELETE SET
    // NULL, so removing a group never removes a project or a container.
    groups.remove(id);
    audit.record({ action: "group.delete", target: String(id), actor: "ui", ip: req.ip });

    res.redirect("/ui/groups?msg=group-removed");
});

// A group is only worth having if it can be acted on as one.
router.post("/:id/deploy", sameOrigin, (req, res, next) => {
    const id = v.integer(req.params.id, null);
    const group = id && groups.byId(id);
    if (!group) return next();

    const members = projects.inGroup(id).filter((project) => project.enabled);
    for (const project of members) {
        deploy.schedule(project, { branch: project.branch, trigger: "manual", actor: "ui" });
    }

    audit.record({
        action: "group.deploy", target: group.name,
        detail: `${members.length} projects`, actor: "ui", ip: req.ip,
    });

    res.redirect("/ui/groups?msg=deployed");
});

router.post("/:id/containers", sameOrigin, async (req, res, next) => {
    const id = v.integer(req.params.id, null);
    const group = id && groups.byId(id);
    if (!group) return next();

    try {
        const members = containerMeta.inGroup(id);
        const results = await docker.actMany(members, v.text(req.body?.action));
        const failed = results.filter((item) => !item.ok);

        audit.record({
            action: `group.containers.${v.text(req.body?.action)}`,
            target: group.name,
            detail: `${results.length - failed.length}/${results.length} ok`,
            actor: "ui", ip: req.ip, ok: failed.length === 0,
        });

        return res.redirect("/ui/groups?msg=bulk");
    } catch (err) {
        return next(err);
    }
});

module.exports = router;
