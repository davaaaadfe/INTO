import { AUTH_SCHEMA_VERSION } from "./auth-repository";
import { LEARNING_REPOSITORY_SCHEMA_VERSION } from "./learning-repository";
import { PostgresAuthRepository } from "./postgres-auth-repository";
import { PostgresLearningRepository } from "./postgres-learning-repository";
import { migratePostgresPersistenceSchema } from "./postgres-store";
import { databaseMode } from "./sqlite-store";

export async function migratePostgresReleaseSchema() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseMode() !== "postgres" || !databaseUrl) {
    throw new Error("DATABASE_MODE=postgres and DATABASE_URL are required.");
  }

  const auth = new PostgresAuthRepository(databaseUrl);
  const learning = new PostgresLearningRepository(databaseUrl);
  await auth.migrate();
  await learning.migrate();
  const [authSchemaVersion, learningSchemaVersion, persistence] =
    await Promise.all([
      auth.schemaVersion(),
      learning.schemaVersion(),
      migratePostgresPersistenceSchema(),
    ]);
  if (
    authSchemaVersion !== AUTH_SCHEMA_VERSION ||
    learningSchemaVersion !== LEARNING_REPOSITORY_SCHEMA_VERSION ||
    !persistence.runtimeStoreReady ||
    !persistence.temporaryInvoiceFilesReady
  ) {
    throw new Error("PostgreSQL release schema verification failed.");
  }
  return { authSchemaVersion, learningSchemaVersion, ...persistence };
}
