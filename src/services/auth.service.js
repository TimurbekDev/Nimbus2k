const crypto = require("node:crypto");

const {
    ADMIN_TOKEN, ADMIN_USER, ADMIN_PASSWORD_HASH, SESSION_TTL_MS,
} = require("../config");
const password = require("../lib/password");

// Length is compared first because timingSafeEqual throws on a mismatch, and
// the length of a secret is not the part worth hiding.
const equals = (a, b) => {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const validToken = (token) => Boolean(ADMIN_TOKEN) && Boolean(token) && equals(token, ADMIN_TOKEN);

// ------------------------------------------------------------------ sign-in

/**
 * The one place a sign-in is decided. Both fields are always checked, even when
 * the name is already wrong, so a wrong name and a wrong password cost the same
 * amount of work.
 *
 * Only ever compares against a digest: a password given in the clear was turned
 * into one at boot.
 */
function verifyCredentials(user, secret) {
    const nameOk = password.sameSecret(user, ADMIN_USER);
    const secretOk = password.verify(secret, ADMIN_PASSWORD_HASH);

    return nameOk && secretOk;
}

// ------------------------------------------------------------------ sessions

// A browser cannot attach an Authorization header to a plain navigation, so the
// UI trades the admin token for a random session id once and keeps that in a
// cookie. Memory is enough: a restart logging everyone out is acceptable, and
// it keeps the token itself off the wire after login.
const sessions = new Map();

function createSession({ ip = null, agent = null } = {}) {
    const id = crypto.randomBytes(32).toString("hex");
    sessions.set(id, { expiresAt: Date.now() + SESSION_TTL_MS, ip, agent, createdAt: Date.now() });
    return id;
}

function validSession(id) {
    const entry = sessions.get(id);
    if (entry === undefined) return false;

    if (entry.expiresAt < Date.now()) {
        sessions.delete(id);
        return false;
    }

    return true;
}

const destroySession = (id) => sessions.delete(id);

const sessionCount = () => {
    const now = Date.now();
    let live = 0;
    for (const entry of sessions.values()) if (entry.expiresAt >= now) live += 1;
    return live;
};

// Unbounded growth otherwise: nothing removes a session whose owner never logs
// out and never comes back.
setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) if (entry.expiresAt < now) sessions.delete(id);
}, 60 * 60 * 1000).unref();

// ------------------------------------------------------------------ throttle

// The login form is reachable from the internet, so guessing the token has to
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

setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of attempts) if (entry.until < now) attempts.delete(ip);
}, 30 * 60 * 1000).unref();

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

module.exports = {
    equals,
    validToken,
    verifyCredentials,
    createSession,
    validSession,
    destroySession,
    sessionCount,
    throttled,
    recordFailure,
    clearFailures,
    readCookie,
    LOCKOUT_MS,
    MAX_ATTEMPTS,
};
