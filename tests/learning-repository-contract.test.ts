import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { LearningRepository } from "../lib/repository/learning-repository-contract";
import type { SqliteLearningRepository } from "../lib/repository/learning-repository";
import type { PostgresLearningRepository } from "../lib/repository/postgres-learning-repository";

function requireLearningRepository(repository: LearningRepository) {
  return repository;
}

test("configured learning persistence exposes one repository port", async () => {
  if (false) {
    requireLearningRepository({} as SqliteLearningRepository);
    requireLearningRepository({} as PostgresLearningRepository);
  }
  const source = await readFile(
    new URL("../lib/repository/configured-learning-repository.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /ConfiguredLearningRepository\s*=\s*LearningRepository/);
  assert.doesNotMatch(
    source,
    /ConfiguredLearningRepository\s*=\s*[\s\S]{0,80}SqliteLearningRepository\s*\|/
  );
});
