import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDatabase } from "./db.js";
import { createService } from "./service.js";
import { createApp } from "./app.js";

const dbPath = process.env.DB_PATH ?? "data/app.db";
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDatabase(dbPath);
const service = createService(db);
const app = createApp(service);

const port = Number(process.env.PORT ?? 8080);
app.listen(port, "0.0.0.0", () => {
  console.log(`training-flow listening on :${port}`);
});
