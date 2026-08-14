const { PORT, HOST } = require("./src/config");
const app = require("./src/app");

const server = app.listen(PORT, HOST, () =>
    console.log(`deploy-server listening on ${HOST}:${PORT}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
}
