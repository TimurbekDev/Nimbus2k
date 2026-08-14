FROM node:24-alpine

# The server shells out to git and docker compose, so both CLIs ship in the
# image. The docker daemon itself comes from the mounted host socket.
# openssh-client is not optional: alpine leaves it out, and a checkout with an
# `git@github.com:` remote fails with "cannot run ssh: No such file or
# directory" the moment it tries to fetch.
RUN apk add --no-cache git openssh-client docker-cli docker-cli-compose

# Checkouts are owned by the host user, not by root inside the container, and
# git refuses to touch them without this.
RUN git config --system --add safe.directory '*'

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY views ./views
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DB_PATH=/data/deploy-server.db

EXPOSE 3000

CMD ["node", "--no-warnings=ExperimentalWarning", "server.js"]
