import test from "node:test";
import assert from "node:assert/strict";
import {
  closeConfiguredLearningRepository,
  configuredLearningRepository,
} from "../lib/repository/configured-learning-repository";
import { PostgresLearningRepository } from "../lib/repository/postgres-learning-repository";

async function withPostgresLearningFactory(
  migrate: (this: PostgresLearningRepository) => Promise<void>,
  run: () => Promise<void>
) {
  const previous = {
    databaseMode: process.env.DATABASE_MODE,
    databaseUrl: process.env.DATABASE_URL,
    learningEnabled: process.env.LEARNING_V2_ENABLED,
    learningMode: process.env.SUPPLIER_LEARNING_MODE,
  };
  const originalMigrate = PostgresLearningRepository.prototype.migrate;

  closeConfiguredLearningRepository();
  process.env.DATABASE_MODE = "postgres";
  process.env.LEARNING_V2_ENABLED = "true";
  process.env.SUPPLIER_LEARNING_MODE = "apply";
  PostgresLearningRepository.prototype.migrate = migrate;

  try {
    await run();
  } finally {
    closeConfiguredLearningRepository();
    PostgresLearningRepository.prototype.migrate = originalMigrate;
    for (const [key, value] of Object.entries({
      DATABASE_MODE: previous.databaseMode,
      DATABASE_URL: previous.databaseUrl,
      LEARNING_V2_ENABLED: previous.learningEnabled,
      SUPPLIER_LEARNING_MODE: previous.learningMode,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a URL switch starts a new learning repository while the old migration is pending", async () => {
  const firstUrl = "postgresql://test:test@first-learning-cache.example/into";
  const secondUrl = "postgresql://test:test@second-learning-cache.example/into";
  const migratedFor = new Map<PostgresLearningRepository, string>();
  let releaseFirst!: () => void;
  const firstMigration = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  await withPostgresLearningFactory(
    async function () {
      const url = process.env.DATABASE_URL!;
      migratedFor.set(this, url);
      if (url === firstUrl) await firstMigration;
    },
    async () => {
      process.env.DATABASE_URL = firstUrl;
      const firstPromise = configuredLearningRepository();

      process.env.DATABASE_URL = secondUrl;
      const secondPromise = configuredLearningRepository();
      const earlySecond = await Promise.race([
        secondPromise,
        new Promise<"blocked">((resolve) =>
          setImmediate(() => resolve("blocked"))
        ),
      ]);

      releaseFirst();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      const secondAgain = await configuredLearningRepository();

      assert.notEqual(earlySecond, "blocked");
      assert.ok(earlySecond instanceof PostgresLearningRepository);
      assert.ok(first instanceof PostgresLearningRepository);
      assert.notEqual(first, earlySecond);
      assert.equal(second, earlySecond);
      assert.equal(secondAgain, earlySecond);
      assert.equal(migratedFor.get(earlySecond), secondUrl);
    }
  );
});

test("closing during migration prevents late completion from recaching the repository", async () => {
  const url = "postgresql://test:test@closed-learning-cache.example/into";
  let migrationCalls = 0;
  let migrationStarted!: () => void;
  let releaseMigration!: () => void;
  const started = new Promise<void>((resolve) => {
    migrationStarted = resolve;
  });
  const migration = new Promise<void>((resolve) => {
    releaseMigration = resolve;
  });

  await withPostgresLearningFactory(
    async function () {
      migrationCalls += 1;
      if (migrationCalls === 1) {
        migrationStarted();
        await migration;
      }
    },
    async () => {
      process.env.DATABASE_URL = url;
      const firstPromise = configuredLearningRepository();
      await started;
      closeConfiguredLearningRepository();
      releaseMigration();

      const first = await firstPromise;
      const afterClose = await configuredLearningRepository();

      assert.ok(first instanceof PostgresLearningRepository);
      assert.ok(afterClose instanceof PostgresLearningRepository);
      assert.notEqual(afterClose, first);
      assert.equal(migrationCalls, 2);
    }
  );
});

test("a failed migration retries the same learning repository identity", async () => {
  const url = "postgresql://test:test@retry-learning-cache.example/into";
  let migrationCalls = 0;

  await withPostgresLearningFactory(
    async function () {
      migrationCalls += 1;
      if (migrationCalls === 1) throw new Error("migration failed");
    },
    async () => {
      process.env.DATABASE_URL = url;
      await assert.rejects(configuredLearningRepository(), /migration failed/);

      const retry = await configuredLearningRepository();

      assert.ok(retry instanceof PostgresLearningRepository);
      assert.equal(migrationCalls, 2);
    }
  );
});

test("concurrent calls for one identity share the same delayed migration", async () => {
  const url = "postgresql://test:test@concurrent-learning-cache.example/into";
  let migrationCalls = 0;
  let releaseMigration!: () => void;
  const migration = new Promise<void>((resolve) => {
    releaseMigration = resolve;
  });

  await withPostgresLearningFactory(
    async function () {
      migrationCalls += 1;
      await migration;
    },
    async () => {
      process.env.DATABASE_URL = url;
      const firstPromise = configuredLearningRepository();
      const secondPromise = configuredLearningRepository();
      releaseMigration();

      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      assert.ok(first instanceof PostgresLearningRepository);
      assert.equal(second, first);
      assert.equal(migrationCalls, 1);
    }
  );
});

test("a late old-identity rejection cannot clear a newer cached repository", async () => {
  const firstUrl = "postgresql://test:test@reject-old-learning-cache.example/into";
  const secondUrl = "postgresql://test:test@survive-new-learning-cache.example/into";
  let migrationCalls = 0;
  let rejectFirst!: (error: Error) => void;
  const firstMigration = new Promise<void>((_resolve, reject) => {
    rejectFirst = reject;
  });

  await withPostgresLearningFactory(
    async function () {
      migrationCalls += 1;
      if (process.env.DATABASE_URL === firstUrl) await firstMigration;
    },
    async () => {
      process.env.DATABASE_URL = firstUrl;
      const firstRejected = assert.rejects(
        configuredLearningRepository(),
        /old migration failed/
      );

      process.env.DATABASE_URL = secondUrl;
      const second = await configuredLearningRepository();
      rejectFirst(new Error("old migration failed"));
      await firstRejected;
      const secondAgain = await configuredLearningRepository();

      assert.ok(second instanceof PostgresLearningRepository);
      assert.equal(secondAgain, second);
      assert.equal(migrationCalls, 2);
    }
  );
});
