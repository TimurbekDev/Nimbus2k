const express = require("express");

const { SESSION_TTL_MS, ADMIN_USER } = require("../../../config");
const {
    verifyCredentials, createSession, validSession, destroySession,
    throttled, recordFailure, clearFailures, readCookie,
} = require("../../../services/auth.service");
const { audit } = require("../../../db/audit.repo");
const { sameOrigin, SESSION_COOKIE, COOKIE_PATH } = require("../../middleware/auth");
const { safeBack } = require("../../middleware/locals");
const v = require("../../../lib/validate");

const router = express.Router();

const cookieOptions = (req) => ({
    httpOnly: true,
    sameSite: "strict",
    // Behind the reverse proxy this is decided by X-Forwarded-Proto, so a
    // plain-HTTP dev run still gets a usable cookie.
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: COOKIE_PATH,
});

router.get("/login", (req, res) => {
    const sid = readCookie(req, SESSION_COOKIE);
    if (sid && validSession(sid)) return res.redirect("/ui");

    res.render("pages/login", {
        title: "Sign in",
        nav: null,
        session: false,
        error: null,
        user: "",
        next: safeBack(req.query.next, "/ui"),
    });
});

router.post("/login", sameOrigin, (req, res) => {
    const target = safeBack(req.body?.next, "/ui");
    const user = v.text(req.body?.user);
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    const fail = (error, status = 401) => res.status(status).render("pages/login", {
        title: "Sign in",
        nav: null,
        session: false,
        error,
        // The name is echoed back so a mistyped password does not cost both
        // fields; the password never is.
        user,
        next: target,
    });

    if (throttled(req.ip)) {
        audit.record({ action: "login.throttled", target: user || null, actor: "ui", ip: req.ip, ok: false });
        return fail("Too many attempts. Try again in 15 minutes.", 429);
    }

    if (!verifyCredentials(user, password)) {
        recordFailure(req.ip);
        // Deliberately one message for both fields: telling an attacker which
        // half was right halves the work.
        audit.record({ action: "login.failed", target: user || null, actor: "ui", ip: req.ip, ok: false });
        return fail("Wrong username or password.");
    }

    clearFailures(req.ip);

    res.cookie(SESSION_COOKIE, createSession({ ip: req.ip, agent: req.get("User-Agent") }), cookieOptions(req));
    audit.record({ action: "login", target: ADMIN_USER, actor: "ui", ip: req.ip });

    res.redirect(target);
});

router.post("/logout", sameOrigin, (req, res) => {
    const sid = readCookie(req, SESSION_COOKIE);
    if (sid) destroySession(sid);

    res.clearCookie(SESSION_COOKIE, { path: COOKIE_PATH });
    audit.record({ action: "logout", actor: "ui", ip: req.ip });

    res.redirect("/ui/login?msg=logged-out");
});

module.exports = router;
