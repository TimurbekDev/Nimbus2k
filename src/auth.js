const crypto = require("node:crypto");

const { ADMIN_TOKEN } = require("./config");

const equals = (a, b) => {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const validToken = (token) => Boolean(ADMIN_TOKEN) && Boolean(token) && equals(token, ADMIN_TOKEN);

// ------------------------------------------------------------------ sessions

// A browser cannot attach an Authorization header to a plain navigation, so the
// UI trades the admin token for a random session id once and keeps that in a
// cookie. Memory is enough: a restart logging everyone out is acceptable, and
// it keeps the token itself off the wire after login.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

function createSession() {
    const id = crypto.randomBytes(32).toString("hex");
    sessions.set(id, Date.now() + SESSION_TTL_MS);
    return id;
}

function validSession(id) {
    const expiresAt = sessions.get(id);
    if (expiresAt === undefined) return false;

    if (expiresAt < Date.now()) {
        sessions.delete(id);
        return false;
    }

    return true;
}

const destroySession = (id) => sessions.delete(id);

// Unbounded growth otherwise: nothing removes a session whose owner never
// logs out and never comes back.
setInterval(() => {
    const now = Date.now();
    for (const [id, expiresAt] of sessions) if (expiresAt < now) sessions.delete(id);
}, 60 * 60 * 1000).unref();

// ------------------------------------------------------------------ throttle

// The login form is reachable from the internet, so a stolen-token guess has to
// cost something. Counted per client address, not globally, so one attacker
// cannot lock the real operator out.
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map();

function throttled(ip) {
    const entry = attempts.get(ip);
    if (!entry) return false;

    if (entry.until < Date.now()) {
        attempts.delete(ip);
        return false;
    }

    return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
    const entry = attempts.get(ip);
    const now = Date.now();

    if (!entry || entry.until < now) {
        attempts.set(ip, { count: 1, until: now + LOCKOUT_MS });
        return;
    }

    entry.count += 1;
    entry.until = now + LOCKOUT_MS;
}

const clearFailures = (ip) => attempts.delete(ip);

// ------------------------------------------------------------------ cookies

function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;

    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index === -1) continue;
        if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1));
    }

    return null;
}

// ------------------------------------------------------------------ middleware

// Admin routes expose repository paths and deploy logs, so they stay closed
// until ADMIN_TOKEN is configured.
function requireAdmin(req, res, next) {
    if (!ADMIN_TOKEN) return res.status(503).json({ error: "ADMIN_TOKEN is not configured" });

    const header = req.get("Authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (!validToken(token)) return res.status(401).json({ error: "Unauthorized" });

    next();
}

module.exports = {
    equals,
    validToken,
    createSession,
    validSession,
    destroySession,
    throttled,
    recordFailure,
    clearFailures,
    readCookie,
    requireAdmin,
    SESSION_TTL_MS,
};
