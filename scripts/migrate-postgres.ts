import { migratePostgresReleaseSchema } from "../lib/repository/release-migrations";

try {
  const result = await migratePostgresReleaseSchema();
  console.log(JSON.stringify({ status: "ready", ...result }));
} catch (error) {
  console.error(JSON.stringify({
    status: "failed",
    error: error instanceof Error ? error.message : "Unknown migration error.",
  }));
  process.exitCode = 1;
}
