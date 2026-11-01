// Entry point on Fly: reads config from the environment.
//   ADMIN_TOKEN      required — bearer token for the admin page (fly secrets set)
//   ALLOWED_ORIGINS  comma list of site origins that may post (default: the Pages site)
//   DATA_DIR         where comments.jsonl lives (default /data, a Fly volume)
//   PORT             default 8080
import path from "node:path";
import { createApp } from "./app.js";

const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken || adminToken.length < 16) {
  console.error("ADMIN_TOKEN must be set (16+ characters): fly secrets set ADMIN_TOKEN=…");
  process.exit(1);
}
const { server, store } = createApp({
  dataFile: path.join(process.env.DATA_DIR || "/data", "comments.jsonl"),
  adminToken,
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "https://brindos-tech.github.io").split(",").map((s) => s.trim()).filter(Boolean),
  ipSalt: process.env.IP_SALT,
});
const port = Number(process.env.PORT) || 8080;
server.listen(port, "0.0.0.0", () => console.log(`comments api on :${port} (${store.size()} comments)`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
