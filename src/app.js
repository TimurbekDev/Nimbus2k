const path = require("node:path");
const express = require("express");

const config = require("./config");
const logger = require("./lib/logger");
const { securityHeaders } = require("./http/middleware/security");
const { notFound, errorHandler } = require("./http/middleware/errors");

const log = logger("app");
const app = express();

// A reverse proxy sits in front, so req.ip and req.secure should follow its
// X-Forwarded-* headers rather than describing the loopback hop.
app.set("trust proxy", config.TRUST_PROXY);
app.set("x-powered-by", false);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(securityHeaders);

// The webhook needs the exact bytes GitHub signed, so the raw body is kept for
// the HMAC check before anything parses it.
app.use(express.json({
    limit: "2mb",
    verify: (req, res, buf) => { req.rawBody = buf; },
}));

// The stylesheet and client scripts; the login page needs them before there is
// a session.
app.use("/assets", express.static(path.join(__dirname, "..", "public"), {
    maxAge: config.IS_PROD ? "7d" : 0,
    etag: true,
}));

// Unauthenticated on purpose: a load balancer has to be able to ask.
app.get("/healthz", (req, res) => res.json({
    ok: true,
    name: config.APP_NAME,
    version: config.VERSION,
    uptimeMs: Math.round(process.uptime() * 1000),
}));

app.use(require("./http/routes/webhook.routes"));
app.use("/api/v1", require("./http/routes/api"));

app.get("/", (req, res) => res.redirect("/ui"));
app.use("/ui", require("./http/routes/ui"));

app.use(notFound);
app.use(errorHandler);

log.debug("routes mounted");

module.exports = app;
