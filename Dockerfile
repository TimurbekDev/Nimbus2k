FROM node:24-alpine

# Nimbus2k shells out to git, docker and docker compose, so all three CLIs ship
# in the image. The daemon itself comes from the mounted host socket.
# openssh-client is not optional: alpine leaves it out, and a checkout with a
# `git@github.com:` remote fails with "cannot run ssh: No such file or
# directory" the moment it tries to fetch.
RUN apk add --no-cache git openssh-client docker-cli docker-cli-compose tini

# Checkouts are owned by the host user, not by root inside the container, and
# git refuses to touch them without this.
RUN git config --system --add safe.directory '*'

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY views ./views
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/nimbus2k.db

EXPOSE 3000

# tini reaps the git and docker children a cancelled deploy leaves behind;
# without an init, PID 1 is node and those become zombies.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--no-warnings=ExperimentalWarning", "src/index.js"]
