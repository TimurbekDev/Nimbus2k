const path = require("node:path");

const bool = (value, fallback) =>
    value === undefined ? fallback : value === "true" || value === "1";

const config = {
    PORT: Number(process.env.PORT || 3000),
    HOST: process.env.HOST || "127.0.0.1",
    PROJECTS_DIR: process.env.PROJECTS_DIR || "/srv/projects",
    SECRET: process.env.GITHUB_WEBHOOK_SECRET || "asdasdas",
    ADMIN_TOKEN: process.env.ADMIN_TOKEN || "12345wrwgfdsgfs",
    DB_PATH: process.env.DB_PATH || path.join(__dirname, "..", "data", "deploy-server.db"),
    STEP_TIMEOUT_MS: Number(process.env.STEP_TIMEOUT_MS || 15 * 60 * 1000),
    // Unknown repository pushing for the first time gets a row automatically,
    // as long as a git checkout already exists under PROJECTS_DIR.
    AUTO_REGISTER: bool(process.env.AUTO_REGISTER, true),
    LOG_TAIL_BYTES: Number(process.env.LOG_TAIL_BYTES || 64 * 1024),
    DEPLOYMENT_HISTORY: Number(process.env.DEPLOYMENT_HISTORY || 50),
};

if (!config.SECRET) {
    console.error("GITHUB_WEBHOOK_SECRET is required");
    process.exit(1);
}

module.exports = config;
