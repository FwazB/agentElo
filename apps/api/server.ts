import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiServer } from "./http.ts";
import { createStore } from "./store.ts";
import { createAntislopStore } from "./antislop/store.ts";

export { createApiServer } from "./http.ts";
export { createStore, lastCompletedWeek, ApiError } from "./store.ts";

export function startServer(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === "production";
  const serviceKey = env.SERVICE_KEY;
  if (!serviceKey || serviceKey.length < 32) throw new Error("Set SERVICE_KEY to at least 32 random characters.");
  if (production && (!env.DATABASE_PATH || !isAbsolute(env.DATABASE_PATH))) {
    throw new Error("Production DATABASE_PATH must be an absolute file path on the mounted persistent volume.");
  }
  const databasePath = env.DATABASE_PATH ?? resolve("var/elo.sqlite");
  if (databasePath === ":memory:") throw new Error("The service requires a persistent DATABASE_PATH.");
  if (!production) mkdirSync(dirname(databasePath), { recursive: true });
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
  const store = createStore({ databasePath });
  const antislop = createAntislopStore({ databasePath });
  const server = createApiServer({ store, serviceKey, antislop });
  server.once("close", () => { antislop.close(); store.close(); });
  server.listen(port, "0.0.0.0", () => console.log(`Computer Elo API listening on port ${port}.`));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = startServer();
  const stop = () => { server.close(); server.closeIdleConnections(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
