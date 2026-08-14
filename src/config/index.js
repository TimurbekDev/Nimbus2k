const path = require("node:path");
const dotenv = require("dotenv");

const ROOT = path.join(__dirname, "..", "..");

dotenv.config({ path: path.join(ROOT, ".env") });

// Every setting is read through one of these three so the whole configuration
// surface stays visible in a single file, and so a typo in the environment
// fails loudly at boot rather than quietly at request time.
const str = (name, fallback = "") => {
    const value = process.env[name];
    return value === undefined || value === "" ? fallback : value;
};

const num = (name, fallback) => {
    const value = process.env[name];
    if (value === undefined || value === "") return fallback;

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${name} must be a number, got ${JSON.stringify(value)}`);
    }

    return parsed;
};

const bool = (name, fallback) => {
    const value = process.env[name];
    if (value === undefined || value === "") return fallback;
    return value === "true" || value === "1" || value === "yes";
};

const config = {
    // --------------------------------------------------------------- identity
    APP_NAME: str("APP_NAME", "Nimbus2k"),
    APP_TAGLINE: str("APP_TAGLINE", "deployment control plane"),
    VERSION: require("../../package.json").version,
    NODE_ENV: str("NODE_ENV", "development"),

    // --------------------------------------------------------------- http
    HOST: str("HOST", "127.0.0.1"),
    PORT: num("PORT", 3000),
    TRUST_PROXY: num("TRUST_PROXY", 1),

    // --------------------------------------------------------------- secrets
    SECRET: str("GITHUB_WEBHOOK_SECRET"),

    // Operators sign in with a name and a password. The password may be given
    // in the clear, or as a scrypt digest so a leaked .env does not hand over a
    // credential a human has probably reused somewhere else.
    ADMIN_USER: str("ADMIN_USER", "admin"),
    ADMIN_PASSWORD: str("ADMIN_PASSWORD"),
    ADMIN_PASSWORD_HASH: str("ADMIN_PASSWORD_HASH"),

    // Machines use a bearer token instead of the login form. Optional: without
    // one the API still accepts the same name and password over HTTP Basic.
    ADMIN_TOKEN: str("ADMIN_TOKEN"),

    SESSION_TTL_MS: num("SESSION_TTL_MS", 12 * 60 * 60 * 1000),

    // --------------------------------------------------------------- storage
    ROOT,
    PROJECTS_DIR: str("PROJECTS_DIR", "/srv/projects"),
    DB_PATH: str("DB_PATH", path.join(ROOT, "data", "nimbus2k.db")),

    // --------------------------------------------------------------- deploys
    STEP_TIMEOUT_MS: num("STEP_TIMEOUT_MS", 15 * 60 * 1000),
    LOG_TAIL_BYTES: num("LOG_TAIL_BYTES", 64 * 1024),
    DEPLOYMENT_HISTORY: num("DEPLOYMENT_HISTORY", 50),
    // An unknown repository pushing for the first time gets a row automatically,
    // as long as a git checkout already exists under PROJECTS_DIR.
    AUTO_REGISTER: bool("AUTO_REGISTER", true),

    // --------------------------------------------------------------- docker
    DOCKER_BIN: str("DOCKER_BIN", "docker"),
    // `docker stats` costs a round trip per container, so the fleet view reuses
    // one sample for this long instead of sampling per request.
    DOCKER_STATS_TTL_MS: num("DOCKER_STATS_TTL_MS", 4000),
    DOCKER_PS_TTL_MS: num("DOCKER_PS_TTL_MS", 1500),
    DOCKER_TIMEOUT_MS: num("DOCKER_TIMEOUT_MS", 20000),
    DOCKER_LOG_TAIL: num("DOCKER_LOG_TAIL", 500),
    // Container start/stop/restart from the browser. Off makes the fleet view
    // strictly read-only, which is the right default for a shared host.
    CONTAINER_ACTIONS: bool("CONTAINER_ACTIONS", true),
    // Deleting a container is the one action that cannot be undone from here.
    CONTAINER_DESTRUCTIVE_ACTIONS: bool("CONTAINER_DESTRUCTIVE_ACTIONS", false),

    // --------------------------------------------------------------- audit
    AUDIT_HISTORY: num("AUDIT_HISTORY", 1000),
};

config.IS_PROD = config.NODE_ENV === "production";

const problems = [];

if (!config.SECRET) problems.push("GITHUB_WEBHOOK_SECRET is required");

if (!config.ADMIN_USER) problems.push("ADMIN_USER is required");

if (!config.ADMIN_PASSWORD && !config.ADMIN_PASSWORD_HASH) {
    problems.push("ADMIN_PASSWORD (or ADMIN_PASSWORD_HASH) is required");
}

// Only the plaintext form can be measured; a digest says nothing about the
// password behind it.
if (config.ADMIN_PASSWORD && !config.ADMIN_PASSWORD_HASH && config.ADMIN_PASSWORD.length < 12) {
    problems.push("ADMIN_PASSWORD must be at least 12 characters");
}

if (config.ADMIN_TOKEN && config.ADMIN_TOKEN.length < 16) {
    problems.push("ADMIN_TOKEN must be at least 16 characters, or left unset");
}

if (problems.length > 0) {
    console.error(`${config.APP_NAME} cannot start:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("\nCopy .env.example to .env and fill it in.");
    process.exit(1);
}

module.exports = config;
