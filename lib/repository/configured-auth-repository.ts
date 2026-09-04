import {
  AUTH_SCHEMA_VERSION,
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
  __INTO_AUTH_REPOSITORY_LOADING?: { identity: string; promise: Promise<ConfiguredAuthRepository> };
};

let repositoryFactoryForTest: (() => ConfiguredAuthRepository) | undefined;

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
  const currentLoading = runtime.__INTO_AUTH_REPOSITORY_LOADING;
  if (currentLoading?.identity === identity) return currentLoading.promise;

  const repository: ConfiguredAuthRepository = repositoryFactoryForTest?.() ?? (databaseMode() === "postgres"
    ? new PostgresAuthRepository()
    : new SqliteAuthRepository(sqliteDatabasePath()));
  const { promise, resolve, reject } = Promise.withResolvers<ConfiguredAuthRepository>();
  const taggedLoading = { identity, promise };
  runtime.__INTO_AUTH_REPOSITORY_LOADING = taggedLoading;
  void (async () => {
    try {
      if (shouldAutoMigrate()) {
        await repository.migrate();
      } else {
        const version = await repository.schemaVersion();
        if (version !== AUTH_SCHEMA_VERSION) {
          throw new Error(
            `Auth database schema ${version} does not match required schema ${AUTH_SCHEMA_VERSION}. Run the release migration command.`
          );
        }
      }
      if (runtime.__INTO_AUTH_REPOSITORY_LOADING === taggedLoading) {
        runtime.__INTO_AUTH_REPOSITORY = repository;
        runtime.__INTO_AUTH_REPOSITORY_IDENTITY = identity;
      }
      resolve(repository);
    } catch (error) {
      repository.close?.();
      reject(error);
    }
  })();
  try {
    return await promise;
  } finally {
    if (runtime.__INTO_AUTH_REPOSITORY_LOADING === taggedLoading) delete runtime.__INTO_AUTH_REPOSITORY_LOADING;
  }
}

export function closeConfiguredAuthRepository() {
  runtime.__INTO_AUTH_REPOSITORY?.close?.();
  delete runtime.__INTO_AUTH_REPOSITORY;
  delete runtime.__INTO_AUTH_REPOSITORY_IDENTITY;
  delete runtime.__INTO_AUTH_REPOSITORY_LOADING;
}

export function setConfiguredAuthRepositoryFactoryForTest(
  factory: (() => ConfiguredAuthRepository) | undefined
) {
  repositoryFactoryForTest = factory;
}
