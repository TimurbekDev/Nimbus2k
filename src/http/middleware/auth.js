const { validToken, verifyCredentials, validSession, readCookie } = require("../../services/auth.service");

const SESSION_COOKIE = "nimbus2k_sid";
const COOKIE_PATH = "/ui";

// A machine can present either the bearer token, when one is configured, or the
// same name and password an operator types into the login form. Basic is always
// accepted so the API is usable without inventing a second secret.
function credentialsFrom(header) {
    if (header.startsWith("Bearer ")) return { kind: "bearer", token: header.slice(7) };

    if (header.startsWith("Basic ")) {
        const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
        const index = decoded.indexOf(":");
        if (index === -1) return null;
        return { kind: "basic", user: decoded.slice(0, index), password: decoded.slice(index + 1) };
    }

    return null;
}

// The API exposes checkout paths, deploy logs and container control, so it stays
// closed to anything that cannot present a credential.
function requireApiToken(req, res, next) {
    const credentials = credentialsFrom(req.get("Authorization") || "");

    const ok = credentials
        && (credentials.kind === "bearer"
            ? validToken(credentials.token)
            : verifyCredentials(credentials.user, credentials.password));

    if (!ok) {
        res.set("WWW-Authenticate", 'Bearer realm="nimbus2k", Basic realm="nimbus2k"');
        return res.status(401).json({ error: "Unauthorized" });
    }

    req.actor = "api";
    next();
}

function requireSession(req, res, next) {
    const sid = readCookie(req, SESSION_COOKIE);

    if (sid && validSession(sid)) {
        req.sid = sid;
        req.actor = "ui";
        return next();
    }

    // A background fetch should get an answer it can act on rather than the
    // HTML of the login page.
    if (req.get("Accept")?.includes("application/json") || req.xhr) {
        return res.status(401).json({ error: "Session expired", login: "/ui/login" });
    }

    const next_ = req.originalUrl.startsWith("/ui") ? `?next=${encodeURIComponent(req.originalUrl)}` : "";
    res.redirect(`/ui/login${next_}`);
}

// SameSite=Strict already stops a cross-site form from carrying the session
// cookie; rejecting a mismatched Origin covers the rest, including the fetch
// calls the client makes for bulk actions.
function sameOrigin(req, res, next) {
    const origin = req.get("Origin");
    if (!origin) return next();

    let host;
    try {
        host = new URL(origin).host;
    } catch {
        return res.status(403).send("Bad Origin");
    }

    if (host !== req.get("Host")) return res.status(403).send("Bad Origin");
    next();
}

module.exports = { requireApiToken, requireSession, sameOrigin, SESSION_COOKIE, COOKIE_PATH };
