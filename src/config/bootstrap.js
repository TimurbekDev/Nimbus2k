const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const password = require("../lib/password");

/*
 * First-run credentials.
 *
 * Nothing has to be in .env for Nimbus2k to start safely. What is missing is
 * generated once, hashed where it can be hashed, and kept beside the database -
 * which is the one directory that survives a rebuild in every deployment shape,
 * including the docker volume.
 *
 * The plaintext password is never stored. If .env holds one, it is turned into
 * an scrypt digest on the first boot that sees it, and the line can then be
 * deleted.
 */
const FILE = "secrets.json";

// Long enough that guessing is hopeless, short enough to retype from a terminal.
const PASSWORD_BYTES = 12;
const WEBHOOK_BYTES = 24;

function read(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        // Absent on a first run, and unreadable means treat it as absent: the
        // values below are all regenerable.
        return {};
    }
}

function write(file, data) {
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });

    // The mode above only applies when the file is created, so an existing one
    // is tightened explicitly. Not every filesystem obliges.
    try {
        fs.chmodSync(file, 0o600);
    } catch {
        // Windows and most bind mounts; the directory permissions still apply.
    }
}

function resolve({ dataDir, env = process.env } = {}) {
    fs.mkdirSync(dataDir, { recursive: true });

    const file = path.join(dataDir, FILE);
    const stored = read(file);
    const generated = {};
    let dirty = false;

    // ------------------------------------------------------------ webhook

    let webhookSecret = env.GITHUB_WEBHOOK_SECRET || "";

    if (!webhookSecret) {
        if (!stored.webhookSecret) {
            stored.webhookSecret = crypto.randomBytes(WEBHOOK_BYTES).toString("hex");
            generated.webhookSecret = stored.webhookSecret;
            dirty = true;
        }
        webhookSecret = stored.webhookSecret;
    }

    // ------------------------------------------------------------ password

    // An explicit hash in the environment always wins: someone who went to the
    // trouble of putting one there is managing it elsewhere.
    let adminPasswordHash = env.ADMIN_PASSWORD_HASH || "";
    let hashedFromEnv = false;

    if (!adminPasswordHash && env.ADMIN_PASSWORD) {
        // Re-hashed only when it is new or has changed, so an unchanged .env
        // does not cost an scrypt round on every boot.
        if (!stored.adminPasswordHash || !password.verify(env.ADMIN_PASSWORD, stored.adminPasswordHash)) {
            stored.adminPasswordHash = password.hash(env.ADMIN_PASSWORD);
            dirty = true;
        }

        adminPasswordHash = stored.adminPasswordHash;
        hashedFromEnv = true;
    }

    if (!adminPasswordHash && stored.adminPasswordHash) {
        adminPasswordHash = stored.adminPasswordHash;
    }

    if (!adminPasswordHash) {
        const secret = crypto.randomBytes(PASSWORD_BYTES).toString("base64url");
        stored.adminPasswordHash = password.hash(secret);
        generated.password = secret;
        adminPasswordHash = stored.adminPasswordHash;
        dirty = true;
    }

    // ------------------------------------------------------------ persist

    let persisted = true;

    if (dirty) {
        try {
            write(file, stored);
        } catch (err) {
            // Worth saying out loud: without a writable store, anything
            // generated here is regenerated on the next boot, and the password
            // printed below stops working.
            persisted = false;
            generated.error = err.message;
        }
    }

    return { webhookSecret, adminPasswordHash, hashedFromEnv, generated, file, persisted };
}

/**
 * Prints anything that was invented on this boot. Once, loudly, and only then:
 * a generated password exists in readable form exactly here and nowhere else.
 */
function announce(bootstrap, { appName = "Nimbus2k", user = "admin" } = {}) {
    const { generated, file, persisted } = bootstrap;
    if (Object.keys(generated).length === 0) return;

    const line = "─".repeat(68);
    const out = [];

    out.push("", line, `  ${appName} generated credentials on this first run`, line, "");

    if (generated.password) {
        out.push("  Sign in with:", "", `      username   ${user}`, `      password   ${generated.password}`, "");
        out.push("  This is the only time it is shown. Store it, or set ADMIN_PASSWORD");
        out.push("  in .env and restart to choose your own.", "");
    }

    if (generated.webhookSecret) {
        out.push("  GitHub webhook secret:", "", `      ${generated.webhookSecret}`, "");
        out.push("  Paste it into the repository's webhook settings. It is shown again");
        out.push("  under Settings in the UI.", "");
    }

    if (!persisted) {
        out.push(`  WARNING: ${file} could not be written (${generated.error}).`);
        out.push("  These values will be different after a restart. Fix the permissions,");
        out.push("  or set them in .env.", "");
    } else {
        out.push(`  Stored, hashed where possible, in ${file}`, "");
    }

    out.push(line, "");

    console.log(out.join("\n"));
}

module.exports = { resolve, announce, FILE };
