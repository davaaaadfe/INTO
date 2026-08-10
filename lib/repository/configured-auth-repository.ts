import {
  type AuthRepository,
  SqliteAuthRepository,
} from "./auth-repository";
import { PostgresAuthRepository } from "./postgres-auth-repository";
import {
  databaseMode,
  databasePersistenceIdentity,
  sqliteDatabasePath,
} from "./sqlite-store";

export type ConfiguredAuthRepository = AuthRepository & {
  close?: () => void;
};

const runtime = globalThis as typeof globalThis & {
  __INTO_AUTH_REPOSITORY?: ConfiguredAuthRepository;
  __INTO_AUTH_REPOSITORY_IDENTITY?: string;
  __INTO_AUTH_REPOSITORY_LOADING?: Promise<ConfiguredAuthRepository>;
};

function shouldAutoMigrate() {
  return process.env.NODE_ENV !== "production";
}

export async function configuredAuthRepository(): Promise<ConfiguredAuthRepository> {
  const identity = databasePersistenceIdentity();
  if (
    runtime.__INTO_AUTH_REPOSITORY &&
    runtime.__INTO_AUTH_REPOSITORY_IDENTITY === identity
  ) {
    return runtime.__INTO_AUTH_REPOSITORY;
  }
  if (runtime.__INTO_AUTH_REPOSITORY_LOADING) return runtime.__INTO_AUTH_REPOSITORY_LOADING;

  const repository: ConfiguredAuthRepository = databaseMode() === "postgres"
    ? new PostgresAuthRepository()
    : new SqliteAuthRepository(sqliteDatabasePath());
  const loading = (async () => {
    if (shouldAutoMigrate()) await repository.migrate();
    runtime.__INTO_AUTH_REPOSITORY = repository;
    runtime.__INTO_AUTH_REPOSITORY_IDENTITY = identity;
    return repository;
  })();
  runtime.__INTO_AUTH_REPOSITORY_LOADING = loading;
  try {
    return await loading;
  } finally {
    if (runtime.__INTO_AUTH_REPOSITORY_LOADING === loading) {
      delete runtime.__INTO_AUTH_REPOSITORY_LOADING;
    }
  }
}

export function closeConfiguredAuthRepository() {
  runtime.__INTO_AUTH_REPOSITORY?.close?.();
  delete runtime.__INTO_AUTH_REPOSITORY;
  delete runtime.__INTO_AUTH_REPOSITORY_IDENTITY;
  delete runtime.__INTO_AUTH_REPOSITORY_LOADING;
}
