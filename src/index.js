const config = require("./config");
const logger = require("./lib/logger");

const log = logger("boot");
const app = require("./app");

const server = app.listen(config.PORT, config.HOST, () => {
    log.info(`${config.APP_NAME} ${config.VERSION} listening`, {
        address: `${config.HOST}:${config.PORT}`,
        env: config.NODE_ENV,
        projects: config.PROJECTS_DIR,
    });
});

// Server-sent event connections are long-lived by design, so a shutdown that
// waits for every socket to close would wait forever. Existing requests get a
// few seconds; after that the process leaves regardless.
const SHUTDOWN_GRACE_MS = 8000;
let closing = false;

function shutdown(signal) {
    if (closing) return;
    closing = true;

    log.info("shutting down", { signal });

    const timer = setTimeout(() => {
        log.warn("forced exit: connections did not close in time");
        process.exit(0);
    }, SHUTDOWN_GRACE_MS);

    timer.unref();

    server.closeIdleConnections?.();
    server.close(() => {
        clearTimeout(timer);
        process.exit(0);
    });
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(signal));

// A crash that leaves the process running in a broken state is worse than a
// restart, and the container has a restart policy.
process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { error: err.message, stack: err.stack });
    shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { error: reason instanceof Error ? reason.message : String(reason) });
});

module.exports = server;
