const express = require("express");

const { APP_NAME } = require("../../../config");
const docker = require("../../../services/docker.service");
const fleet = require("../../../services/fleet.service");
const { groups, containerMeta } = require("../../../db/groups.repo");
const { audit } = require("../../../db/audit.repo");
const v = require("../../../lib/validate");
const { sameOrigin } = require("../../middleware/auth");
const { safeBack } = require("../../middleware/locals");

const router = express.Router();

const encode = encodeURIComponent;

// The view is entirely described by the query string, so a filtered fleet is a
// link an operator can bookmark or paste into a ticket.
const readView = (query) => ({
    groupBy: v.oneOf(query.by, Object.keys(fleet.GROUP_BY), "stack"),
    sortBy: v.oneOf(query.sort, Object.keys(fleet.SORT_BY), "state"),
    state: v.oneOf(query.state, ["all", "running", "stopped", "unhealthy"], "all"),
    search: v.text(query.q),
    groupId: v.integer(query.group, null) || null,
});

// ---------------------------------------------------------------- fleet

router.get("/", async (req, res) => {
    const options = readView(req.query);
    const view = await fleet.view(options);

    res.render("pages/containers", {
        title: "Fleet",
        nav: "containers",
        view,
        options,
        groups: groups.list(),
        axes: fleet.GROUP_BY,
        sorts: Object.keys(fleet.SORT_BY),
        density: v.oneOf(req.query.density, ["cosy", "compact"], "cosy"),
    });
});

// ---------------------------------------------------------------- detail

router.get("/:ref", async (req, res, next) => {
    const { ref } = req.params;
    if (!v.CONTAINER_REF.test(ref)) return next();

    const container = await docker.byRef(ref);
    if (!container) return next();

    const [detail, logText] = await Promise.all([
        docker.inspect(container.id).catch(() => null),
        docker.logs(container.id, { tail: 400 })
            .catch((err) => `${APP_NAME} could not read this container's log:\n${err.message}`),
    ]);

    const meta = containerMeta.all().get(container.name) || null;

    res.render("pages/container", {
        title: container.name,
        nav: "containers",
        container: { ...container, group: meta?.group || null, pinned: meta?.pinned || false, note: meta?.note || null },
        detail,
        log: logText,
        groups: groups.list(),
    });
});

router.get("/:ref/logs", async (req, res, next) => {
    const { ref } = req.params;
    if (!v.CONTAINER_REF.test(ref)) return next();

    const tail = v.integer(req.query.tail, 1000, { min: 10, max: 20000 });
    res.type("text/plain").send(await docker.logs(ref, { tail, timestamps: true }));
});

// ---------------------------------------------------------------- actions

router.post("/:ref/action", sameOrigin, async (req, res, next) => {
    const { ref } = req.params;
    if (!v.CONTAINER_REF.test(ref)) return next();

    const action = v.text(req.body?.action);
    const back = safeBack(req.body?.back, "/ui/containers");

    try {
        const result = await docker.act(ref, action);
        audit.record({ action: `container.${action}`, target: ref, actor: "ui", ip: req.ip });
        return res.redirect(`${back}?msg=${result.verb}`);
    } catch (err) {
        audit.record({ action: `container.${action}`, target: ref, detail: err.message, actor: "ui", ip: req.ip, ok: false });
        return next(err);
    }
});

// One action over a whole bucket. The membership is resolved server-side from
// the bucket identity, so a form never posts a container list a client could
// have rewritten.
router.post("/bulk", sameOrigin, async (req, res, next) => {
    const action = v.text(req.body?.action);
    const back = safeBack(req.body?.back, "/ui/containers");

    const scope = {
        stack: v.optional(req.body?.stack, "stack", v.STACK_NAME),
        groupId: v.integer(req.body?.group_id, null) || null,
        project: v.optional(req.body?.project, "project", v.PROJECT_NAME),
        state: v.oneOf(req.body?.state, ["running", "stopped"], null),
    };

    if (!scope.stack && !scope.groupId && !scope.project) {
        return next(new v.ValidationError("A bulk action needs a stack, a group or a project", "scope"));
    }

    try {
        const members = await fleet.membersOf(scope);
        const results = await docker.actMany(members, action);
        const failed = results.filter((item) => !item.ok);

        audit.record({
            action: `fleet.${action}`,
            target: scope.stack || scope.project || `group:${scope.groupId}`,
            detail: `${results.length - failed.length}/${results.length} ok`,
            actor: "ui",
            ip: req.ip,
            ok: failed.length === 0,
        });

        return res.redirect(`${back}?msg=bulk`);
    } catch (err) {
        return next(err);
    }
});

// ---------------------------------------------------------------- grouping

// The one thing about a container that Nimbus2k owns rather than docker: which
// group it belongs to, whether it is pinned, and the operator's note.
router.post("/:ref/meta", sameOrigin, (req, res, next) => {
    const { ref } = req.params;
    if (!v.CONTAINER_REF.test(ref)) return next();

    const patch = {};

    if (req.body?.group_id !== undefined) {
        const id = v.integer(req.body.group_id, null) || null;
        if (id !== null && !groups.byId(id)) return next(new v.ValidationError("No such group", "group_id"));
        patch.group_id = id;
    }

    if (req.body?.note !== undefined) patch.note = v.text(req.body.note).slice(0, 280) || null;
    if (req.body?.pinned !== undefined) patch.pinned = v.checkbox(req.body.pinned);

    containerMeta.set(ref, patch);
    audit.record({ action: "container.group", target: ref, detail: JSON.stringify(patch), actor: "ui", ip: req.ip });

    res.redirect(`${safeBack(req.body?.back, `/ui/containers/${encode(ref)}`)}?msg=grouped`);
});

module.exports = router;
