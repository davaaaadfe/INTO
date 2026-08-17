import {
  SqliteLearningRepository,
} from "./learning-repository";
import { PostgresLearningRepository } from "./postgres-learning-repository";
import type { LearningRepository } from "./learning-repository-contract";
import {
  databaseMode,
  databasePersistenceIdentity,
  sqliteDatabasePath,
} from "./sqlite-store";
import {
  learningFeatureFlags,
  supplierLearningMode,
} from "../services/learning-feature-flags";

export type ConfiguredLearningRepository = LearningRepository;

type LearningRepositoryLoading = {
  identity: string;
  promise: Promise<ConfiguredLearningRepository>;
};

const runtime = globalThis as typeof globalThis & {
  __INTO_LEARNING_REPOSITORY?: ConfiguredLearningRepository;
  __INTO_LEARNING_REPOSITORY_IDENTITY?: string;
  __INTO_LEARNING_REPOSITORY_LOADING?: LearningRepositoryLoading;
  __INTO_CLOSE_LEARNING_REPOSITORY?: () => void;
};

function closeCurrentRepository() {
  const current = runtime.__INTO_LEARNING_REPOSITORY;
  current?.close?.();
  delete runtime.__INTO_LEARNING_REPOSITORY;
  delete runtime.__INTO_LEARNING_REPOSITORY_IDENTITY;
}

export async function configuredLearningRepository(): Promise<
  ConfiguredLearningRepository | null
> {
  const flags = learningFeatureFlags();
  const mode = databaseMode();
  if (
    !flags.learningV2Enabled ||
    supplierLearningMode() === "off" ||
    mode === "memory"
  ) {
    return null;
  }
  if (mode === "postgres" && !process.env.DATABASE_URL?.trim()) {
    return null;
  }

  const identity = databasePersistenceIdentity();
  if (
    runtime.__INTO_LEARNING_REPOSITORY &&
    runtime.__INTO_LEARNING_REPOSITORY_IDENTITY === identity
  ) {
    return runtime.__INTO_LEARNING_REPOSITORY;
  }
  const currentLoading = runtime.__INTO_LEARNING_REPOSITORY_LOADING;
  if (currentLoading?.identity === identity) {
    return currentLoading.promise;
  }

  closeCurrentRepository();
  const repository =
    mode === "sqlite"
      ? new SqliteLearningRepository(sqliteDatabasePath())
      : new PostgresLearningRepository();
  const { promise, resolve, reject } =
    Promise.withResolvers<ConfiguredLearningRepository>();
  const loading = { identity, promise };
  runtime.__INTO_LEARNING_REPOSITORY_LOADING = loading;
  void (async () => {
    try {
      await repository.migrate();
      if (runtime.__INTO_LEARNING_REPOSITORY_LOADING === loading) {
        runtime.__INTO_LEARNING_REPOSITORY = repository;
        runtime.__INTO_LEARNING_REPOSITORY_IDENTITY = identity;
      }
      resolve(repository);
    } catch (error) {
      reject(error);
    } finally {
      if (runtime.__INTO_LEARNING_REPOSITORY_LOADING === loading) {
        delete runtime.__INTO_LEARNING_REPOSITORY_LOADING;
      }
    }
  })();
  return promise;
}

export function closeConfiguredLearningRepository() {
  closeCurrentRepository();
  delete runtime.__INTO_LEARNING_REPOSITORY_LOADING;
}

runtime.__INTO_CLOSE_LEARNING_REPOSITORY = closeConfiguredLearningRepository;
