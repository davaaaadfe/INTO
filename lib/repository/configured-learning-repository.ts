import {
  SqliteLearningRepository,
} from "./learning-repository";
import { PostgresLearningRepository } from "./postgres-learning-repository";
import {
  databaseMode,
  databasePersistenceIdentity,
  sqliteDatabasePath,
} from "./sqlite-store";
import {
  learningFeatureFlags,
  supplierLearningMode,
} from "../services/learning-feature-flags";

export type ConfiguredLearningRepository =
  | SqliteLearningRepository
  | PostgresLearningRepository;

const runtime = globalThis as typeof globalThis & {
  __INTO_LEARNING_REPOSITORY?: ConfiguredLearningRepository;
  __INTO_LEARNING_REPOSITORY_IDENTITY?: string;
  __INTO_LEARNING_REPOSITORY_LOADING?: Promise<
    ConfiguredLearningRepository | null
  >;
  __INTO_CLOSE_LEARNING_REPOSITORY?: () => void;
};

function closeCurrentRepository() {
  const current = runtime.__INTO_LEARNING_REPOSITORY;
  if (current instanceof SqliteLearningRepository) {
    current.close();
  }
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
  if (!runtime.__INTO_LEARNING_REPOSITORY_LOADING) {
    runtime.__INTO_LEARNING_REPOSITORY_LOADING = (async () => {
      closeCurrentRepository();
      const repository =
        mode === "sqlite"
          ? new SqliteLearningRepository(sqliteDatabasePath())
          : new PostgresLearningRepository();
      await repository.migrate();
      runtime.__INTO_LEARNING_REPOSITORY = repository;
      runtime.__INTO_LEARNING_REPOSITORY_IDENTITY = identity;
      return repository;
    })().finally(() => {
      delete runtime.__INTO_LEARNING_REPOSITORY_LOADING;
    });
  }
  return runtime.__INTO_LEARNING_REPOSITORY_LOADING;
}

export function closeConfiguredLearningRepository() {
  closeCurrentRepository();
  delete runtime.__INTO_LEARNING_REPOSITORY_LOADING;
}

runtime.__INTO_CLOSE_LEARNING_REPOSITORY = closeConfiguredLearningRepository;
