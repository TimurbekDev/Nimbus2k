#!/bin/sh
# The nginx image runs every executable script in /docker-entrypoint.d before
# it execs nginx itself, which is the one hook that keeps the default command
# intact - overriding `command:` would skip the envsubst templating step.
#
# certbot renews inside its own container and has no way to signal this one, so
# a renewed certificate would sit on the volume unused until the next restart.
# Reloading on a timer picks it up instead.
set -e

(
    while :; do
        sleep 6h
        nginx -s reload
    done
) &
