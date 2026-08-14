// The UI ships no third-party code and loads nothing from another origin, so
// the policy can be as tight as it looks. `unsafe-inline` covers only styles:
// meters and sparklines are sized with an inline `style` attribute from
// server-rendered numbers, never from anything a request supplies.
const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
].join("; ");

function securityHeaders(req, res, next) {
    res.set({
        "Content-Security-Policy": CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "X-Frame-Options": "DENY",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    });

    // Behind the reverse proxy this is decided by X-Forwarded-Proto, so a
    // plain-HTTP dev run does not pin a browser to a scheme it cannot serve.
    if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

    next();
}

module.exports = { securityHeaders, CSP };
