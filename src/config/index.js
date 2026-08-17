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

    // --------------------------------------------------------------- storage
    ROOT,
    PROJECTS_DIR: str("PROJECTS_DIR", "/srv/projects"),
    DB_PATH: str("DB_PATH", path.join(ROOT, "data", "nimbus2k.db")),

    // --------------------------------------------------------------- secrets
    // Operators sign in with a name and a password. Only the digest is ever
    // held: a plaintext ADMIN_PASSWORD is hashed on the first boot that sees
    // it, after which the line can be deleted from .env.
    ADMIN_USER: str("ADMIN_USER", "admin"),

    // Machines use a bearer token instead of the login form. Optional: without
    // one the API still accepts the same name and password over HTTP Basic.
    ADMIN_TOKEN: str("ADMIN_TOKEN"),

    SESSION_TTL_MS: num("SESSION_TTL_MS", 12 * 60 * 60 * 1000),

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

// ------------------------------------------------------------------ checks

// Only what an operator can get wrong. Everything else has a default, and the
// two credentials are generated when they are missing rather than refused.
const problems = [];

if (!config.ADMIN_USER) problems.push("ADMIN_USER cannot be empty");

// A digest says nothing about the password behind it, so only the plaintext
// form can be measured.
const plaintext = str("ADMIN_PASSWORD");
if (plaintext && !str("ADMIN_PASSWORD_HASH") && plaintext.length < 12) {
    problems.push("ADMIN_PASSWORD must be at least 12 characters");
}

if (config.ADMIN_TOKEN && config.ADMIN_TOKEN.length < 16) {
    problems.push("ADMIN_TOKEN must be at least 16 characters, or left unset");
}

if (problems.length > 0) {
    console.error(`${config.APP_NAME} cannot start:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("\nEverything in .env is optional; fix or remove the value above.");
    process.exit(1);
}

// ------------------------------------------------------------------ secrets

// Generates and persists whatever the environment did not supply. Runs before
// anything else opens the data directory, and is the only place that ever sees
// a plaintext password.
const bootstrap = require("./bootstrap").resolve({
    dataDir: path.dirname(config.DB_PATH),
});

config.SECRET = bootstrap.webhookSecret;
config.ADMIN_PASSWORD_HASH = bootstrap.adminPasswordHash;
config.SECRET_GENERATED = Boolean(bootstrap.generated.webhookSecret);
config.PASSWORD_FROM_ENV = bootstrap.hashedFromEnv;
config.BOOTSTRAP = bootstrap;

module.exports = config;
