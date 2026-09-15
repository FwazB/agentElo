import { chownSync, chmodSync, lstatSync } from "node:fs";

// Only the fixed persistent database and SQLite sidecars may be migrated.
// Refuse links and unexpected file types; never recursively chown a volume.
if (process.env.DATABASE_PATH !== "/data/elo.sqlite") {
  throw new Error("The container requires DATABASE_PATH=/data/elo.sqlite on its persistent volume.");
}
const directory = lstatSync("/data");
if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Invalid database volume.");
if (process.getuid() === 0) {
  for (const path of ["/data/elo.sqlite", "/data/elo.sqlite-wal", "/data/elo.sqlite-shm", "/data/elo.sqlite-journal"]) {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Invalid database file.");
    chownSync(path, 1000, 1000);
    chmodSync(path, 0o600);
  }
  chownSync("/data", 1000, 1000);
  chmodSync("/data", 0o700);
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
}
if (process.getuid() !== 1000 || process.getgid() !== 1000 || process.getgroups().some(group => group !== 1000)) {
  throw new Error("Application privileges were not dropped.");
}
process.umask(0o077);
const { startServer } = await import("./server.mjs");
const server = startServer();
console.log("Database ready; API process runs as uid 1000.");
const stop = () => { server.close(); server.closeIdleConnections(); };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
