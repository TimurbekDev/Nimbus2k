FROM node:24-alpine

# The server shells out to git and docker compose, so both CLIs ship in the
# image. The docker daemon itself comes from the mounted host socket.
RUN apk add --no-cache git docker-cli docker-cli-compose

# Checkouts are owned by the host user, not by root inside the container, and
# git refuses to touch them without this.
RUN git config --system --add safe.directory '*'

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY config.js db.js deployer.js app.js ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DB_PATH=/data/deploy-server.db

EXPOSE 3000

CMD ["node", "--no-warnings=ExperimentalWarning", "app.js"]
