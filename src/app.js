const path = require("node:path");
const express = require("express");

const webhook = require("./routes/webhook");
const api = require("./routes/api");
const ui = require("./routes/ui");

const app = express();

// One reverse proxy sits in front, so req.ip and req.secure should follow its
// X-Forwarded-* headers rather than describing the loopback hop.
app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(express.json({
    limit: "1mb",
    verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Stylesheet and the client script; the login page needs them before there is
// a session.
app.use("/assets", express.static(path.join(__dirname, "..", "public"), { maxAge: "1h" }));

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.use(webhook);
app.use(api);

app.get("/", (req, res) => res.redirect("/ui"));
app.use("/ui", ui);

module.exports = app;
