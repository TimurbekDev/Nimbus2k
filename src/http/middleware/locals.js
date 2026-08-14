const config = require("../../config");
const fmt = require("../../lib/format");

// Flash messages travel in the query string, so only these keys are ever turned
// into text: whatever a link carries can never become page content.
const FLASH = {
    deployed: { tone: "ok", text: "Deploy started." },
    queued: { tone: "info", text: "A deploy is already running — this one is queued behind it." },
    cancelled: { tone: "warn", text: "Deploy cancelled." },
    saved: { tone: "ok", text: "Settings saved." },
    created: { tone: "ok", text: "Project registered." },
    deleted: { tone: "warn", text: "Project removed. Its containers were left running." },
    grouped: { tone: "ok", text: "Grouping updated." },
    "group-created": { tone: "ok", text: "Group created." },
    "group-removed": { tone: "warn", text: "Group removed. Nothing inside it was deleted." },
    started: { tone: "ok", text: "Container started." },
    stopped: { tone: "warn", text: "Container stopped." },
    restarted: { tone: "ok", text: "Container restarted." },
    paused: { tone: "warn", text: "Container paused." },
    resumed: { tone: "ok", text: "Container resumed." },
    removed: { tone: "warn", text: "Container removed." },
    bulk: { tone: "ok", text: "Bulk action finished." },
    pruned: { tone: "ok", text: "Reclaimed disk space." },
    "logged-out": { tone: "info", text: "Signed out." },
};

// Every page gets the same shell, so the sidebar is described once here rather
// than repeated in each template.
const NAV = [
    { id: "overview", href: "/ui", label: "Overview", icon: "grid" },
    { id: "projects", href: "/ui/projects", label: "Projects", icon: "git" },
    { id: "containers", href: "/ui/containers", label: "Fleet", icon: "box" },
    { id: "groups", href: "/ui/groups", label: "Groups", icon: "folder" },
    { id: "deployments", href: "/ui/deployments", label: "Deployments", icon: "history" },
    { id: "settings", href: "/ui/settings", label: "Settings", icon: "settings" },
];

function locals(req, res, next) {
    res.locals.fmt = fmt;
    res.locals.app = {
        name: config.APP_NAME,
        tagline: config.APP_TAGLINE,
        version: config.VERSION,
        env: config.NODE_ENV,
    };
    res.locals.nav = null;
    res.locals.navItems = NAV;
    res.locals.session = true;
    res.locals.flash = FLASH[req.query.msg] || null;
    res.locals.query = req.query;
    res.locals.path = req.path;
    res.locals.canAct = config.CONTAINER_ACTIONS;
    res.locals.canDestroy = config.CONTAINER_DESTRUCTIVE_ACTIONS;

    next();
}

// Whitelisted rather than echoed back: an arbitrary value in a form field would
// turn every redirect into an open redirect.
const safeBack = (value, fallback = "/ui") =>
    (typeof value === "string" && value.startsWith("/ui") && !value.startsWith("//") ? value : fallback);

const redirectWith = (res, target, msg) => res.redirect(msg ? `${target}?msg=${msg}` : target);

module.exports = { locals, NAV, FLASH, safeBack, redirectWith };
