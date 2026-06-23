"use strict";

const { startDashboard } = require("./src/dashboard/server");

const requestedPort = Number(process.env.XFEEDER_DASHBOARD_PORT);
const requestedHost = process.env.XFEEDER_DASHBOARD_HOST || "127.0.0.1";

startDashboard({
  host: requestedHost,
  port: Number.isFinite(requestedPort) && requestedPort >= 0 ? requestedPort : 3000,
});
