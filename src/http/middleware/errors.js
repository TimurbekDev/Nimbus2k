const { IS_PROD } = require("../../config");
const logger = require("../../lib/logger");

const log = logger("http");

const wantsJson = (req) =>
    req.path.startsWith("/api") || (req.get("Accept") || "").includes("application/json");

function notFound(req, res) {
    if (wantsJson(req)) return res.status(404).json({ error: "Not found", path: req.path });

    res.status(404).render("pages/message", {
        title: "Not found",
        nav: null,
        tone: "warn",
        heading: "There is nothing at this address",
        body: req.path,
        action: { href: "/ui", label: "Back to overview" },
    });
}

// Async route handlers reject rather than throw, and express 5 forwards a
// rejected promise here, so nothing needs wrapping at the call site.
function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    const status = err.status || err.statusCode || 500;

    if (status >= 500) log.error("request failed", { path: req.path, error: err.message });
    else log.warn("request rejected", { path: req.path, status, error: err.message });

    // A 500 from a bug can carry an internal path in its message; a 4xx is
    // something the caller did and needs to read.
    const message = status >= 500 && IS_PROD ? "Internal error" : err.message;

    if (wantsJson(req)) {
        return res.status(status).json({ error: message, field: err.field });
    }

    res.status(status).render("pages/message", {
        title: status >= 500 ? "Error" : "Rejected",
        nav: null,
        tone: status >= 500 ? "bad" : "warn",
        heading: status >= 500 ? "Something went wrong" : message,
        body: status >= 500 ? message : (err.field ? `Field: ${err.field}` : ""),
        action: { href: "/ui", label: "Back to overview" },
    });
}

module.exports = { notFound, errorHandler };
