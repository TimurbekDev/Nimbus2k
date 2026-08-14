#!/usr/bin/env node
/*
 * Turns a password into the scrypt digest ADMIN_PASSWORD_HASH expects, so the
 * plaintext never has to live in .env.
 *
 *     npm run hash-password
 *     npm run hash-password -- 'the password'
 *
 * Deliberately independent of src/config: this runs before the server is
 * configured, which is the whole point of it.
 */
const readline = require("node:readline");

const password = require("../lib/password");

const MIN_LENGTH = 12;

function emit(secret) {
    if (secret.length < MIN_LENGTH) {
        console.error(`error: use at least ${MIN_LENGTH} characters (got ${secret.length})`);
        process.exit(1);
    }

    console.log("\nAdd this to .env, and remove ADMIN_PASSWORD:\n");
    console.log(`ADMIN_PASSWORD_HASH=${password.hash(secret)}\n`);
}

const [, , fromArgv] = process.argv;

if (fromArgv) {
    emit(fromArgv);
} else {
    // No echo suppression: a TTY-less environment (a container, a pipe) would
    // hang on it, and the value is about to be printed anyway.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Password: ", (answer) => {
        rl.close();
        emit(answer.trim());
    });
}
