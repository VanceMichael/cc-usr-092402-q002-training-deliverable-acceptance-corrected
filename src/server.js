import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDb } from "./db.js";
import { createServices } from "./domain.js";
import { createApp } from "./app.js";

const DB_PATH = process.env.DB_PATH || "data/app.db";
const PORT = Number(process.env.PORT || 8080);

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = openDb(DB_PATH);
const services = createServices(db);
const app = createApp(services);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`training-flow listening on :${PORT} (db ${DB_PATH})`);
});
