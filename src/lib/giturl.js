const { ValidationError, PROJECT_NAME } = require("./validate");

/*
 * A repository URL an operator typed is about to become an argument to `git
 * clone`. Nothing is passed through a shell, so the danger is not quoting - it
 * is git itself, which treats some URLs as instructions:
 *
 *   ext::sh -c 'whatever'     runs a command as a transport
 *   -u./payload               a leading dash is read as an option
 *   file:///srv/anything       clones a path on this host
 *
 * So the shape is decided here, from a closed list, before git ever sees it.
 */

// git@github.com:owner/repo.git - the scp-like form, which is not a URL at all
// and therefore has to be matched rather than parsed.
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:(?!\/)[A-Za-z0-9._~\-/]+$/;

// https and ssh cover every hosted forge; http is allowed because a forge on
// the same LAN is a normal thing to have.
const SCHEMES = new Set(["https:", "http:", "ssh:"]);

const CONTROL = /[\s\u0000-\u001f\u007f]/;

const MAX_LENGTH = 512;

function reject(message) {
    throw new ValidationError(message, "repo_url");
}

/**
 * Validates a repository URL and works out the project name it implies.
 * Returns `{ url, host, name }`; throws ValidationError otherwise.
 */
function parse(input) {
    const url = String(input ?? "").trim();

    if (!url) reject("A repository URL is required");
    if (url.length > MAX_LENGTH) reject("That URL is too long");
    if (CONTROL.test(url)) reject("A repository URL cannot contain spaces or control characters");

    // git reads a leading dash as an option, whatever follows it.
    if (url.startsWith("-")) reject("A repository URL cannot start with a dash");

    let host;
    let repoPath;

    if (SCP_LIKE.test(url)) {
        const [, hostPart, pathPart] = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):(.+)$/.exec(url);
        host = hostPart;
        repoPath = pathPart;
    } else {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            reject("That does not look like a repository URL");
        }

        if (!SCHEMES.has(parsed.protocol)) {
            reject(`Only https, http and ssh URLs are supported (got ${parsed.protocol.replace(":", "")})`);
        }

        if (!parsed.hostname) reject("That URL has no host");

        host = parsed.hostname;
        repoPath = parsed.pathname;
    }

    // The local directory is built from the derived name rather than from this
    // path, so `..` cannot escape anywhere - but it is still not a repository
    // path anyone means to type.
    if (repoPath.split("/").some((segment) => segment === "." || segment === "..")) {
        reject("A repository path cannot contain . or ..");
    }

    // `owner/repo.git` -> `repo`, which is also the name GitHub puts in the
    // webhook payload, and the two have to agree for a push to find the project.
    const name = repoPath
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "")
        .split("/")
        .pop();

    if (!name || !PROJECT_NAME.test(name)) {
        reject("The repository name in that URL is not usable — letters, digits, dot, dash and underscore only");
    }

    return { url, host, name };
}

// Only for display: a URL may carry a token in the userinfo, and the project
// page is not the place to publish it.
function redact(url) {
    const text = String(url ?? "");
    if (!text) return "";

    try {
        const parsed = new URL(text);
        if (!parsed.username && !parsed.password) return text;

        parsed.username = parsed.username ? "***" : "";
        parsed.password = "";
        return parsed.toString();
    } catch {
        // The scp-like form carries a user but never a secret.
        return text;
    }
}

module.exports = { parse, redact, SCP_LIKE };
