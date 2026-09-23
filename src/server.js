import Database from "better-sqlite3";
import Koa from "koa";

const db = new Database("data/app.db");
db.pragma("journal_mode = WAL");
const app = new Koa();
app.use(async (ctx) => {
  if (ctx.path === "/health") {
    db.prepare("select 1").get();
    ctx.status = 200;
    ctx.body = { status: "ok" };
  }
});
app.listen(8080, "0.0.0.0");
