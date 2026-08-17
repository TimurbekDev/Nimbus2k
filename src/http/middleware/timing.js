const logger = require("../../lib/logger");

const log = logger("http");

// Anything past this is worth a line in the log: a page an operator waits on
// should be tens of milliseconds, and everything slow here is a docker call
// that should have been served from cache.
const SLOW_MS = 400;

// The streams are long-lived by design and would otherwise be reported as the
// slowest requests on the server.
const STREAMING = /^\/ui\/(events|containers\/[^/]+\/stream)$/;

function timing(req, res, next) {
    if (STREAMING.test(req.path)) return next();

    const started = process.hrtime.bigint();

    res.on("finish", () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        if (ms < SLOW_MS) return;

        log.warn("slow request", {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            ms: Math.round(ms),
        });
    });

    next();
}

module.exports = { timing, SLOW_MS };
