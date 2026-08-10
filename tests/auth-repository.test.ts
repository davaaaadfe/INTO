import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AuthSchemaVersionError,
  AuthEmailValidationError,
  SqliteAuthRepository,
  SQLITE_AUTH_V1_CHECKSUM,
  inventoryLegacyUsers,
  inventoryRawSqliteSnapshot,
  mapLegacyRole,
} from "../lib/repository/auth-repository";
import {
  closeConfiguredAuthRepository,
  configuredAuthRepository,
} from "../lib/repository/configured-auth-repository";

function databasePath() {
  return resolve(
    "data/tmp-tests",
    `auth-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
}

async function withRepository(
  run: (repository: SqliteAuthRepository) => Promise<void>
) {
  const path = databasePath();
  const repository = new SqliteAuthRepository(path);
  try {
    await repository.migrate();
    await run(repository);
  } finally {
    repository.close();
    await rm(path, { force: true });
    await rm(`${path}-shm`, { force: true });
    await rm(`${path}-wal`, { force: true });
  }
}

test("SQLite auth migration creates safe normalized storage and is replayable", async () => {
  await withRepository(async (repository) => {
    await repository.migrate();
    assert.equal(await repository.schemaVersion(), 3);
    assert.deepEqual(await repository.tableNames(), [
      "into_auth_credentials",
      "into_auth_events",
      "into_auth_invitations",
      "into_auth_schema_migrations",
      "into_auth_sessions",
      "into_auth_users",
    ]);
    const schema = await repository.schemaSql();
    assert.match(schema, /CHECK \(json_valid\(metadata_json\)\)/);
    assert.doesNotMatch(schema, /raw_token|password(?:\s|,|\))/i);
  });
});

test("SQLite auth migration fails closed for a future schema before auth DDL", async () => {
  const path = databasePath();
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE into_auth_schema_migrations (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT INTO into_auth_schema_migrations (version, checksum, applied_at)
    VALUES (99, 'future', '2026-08-10T00:00:00.000Z');
  `);
  database.close();
  const repository = new SqliteAuthRepository(path);
  try {
    await assert.rejects(repository.migrate(), AuthSchemaVersionError);
    const verify = new DatabaseSync(path);
    try {
      assert.equal(
        verify
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='into_auth_users'")
          .get(),
        undefined
      );
    } finally {
      verify.close();
    }
  } finally {
    repository.close();
    await rm(path, { force: true });
  }
});

test("legacy role inventory maps verified roles without treating role as verification", async () => {
  const expected = ["Admin", "Accountant", "Reviewer", "Viewer"];
  for (const role of expected.flatMap((value) => [value, value.toLowerCase()])) {
    assert.equal(mapLegacyRole(role), "verified_user");
  }
  assert.equal(mapLegacyRole("shared_user"), null);
  assert.equal(mapLegacyRole("unknown"), null);

  const inventory = inventoryLegacyUsers({
    users: [
      { id: "admin", email: "ADMIN@Example.test", name: "Admin", role: "Admin" },
      { id: "active", email: "active@example.test", role: "reviewer", verifiedAt: "2026-08-01T00:00:00.000Z" },
      { id: "disabled", email: "disabled@example.test", role: "Viewer", status: "disabled", verifiedAt: "2026-08-01T00:00:00.000Z" },
      { id: "shared_user", email: "shared_user@internal", role: "Admin" },
      { id: "unknown", email: "unknown@example.test", role: "owner" },
      { id: "missing", email: "missing@example.test" },
    ],
  });

  assert.deepEqual(inventory.users, [
    {
      id: "active",
      email: "active@example.test",
      displayName: "active@example.test",
      status: "active",
      accessLevel: "verified_user",
      verifiedAt: "2026-08-01T00:00:00.000Z",
    },
    {
      id: "admin",
      email: "admin@example.test",
      displayName: "Admin",
      status: "invited",
      accessLevel: "verified_user",
      verifiedAt: null,
    },
    {
      id: "disabled",
      email: "disabled@example.test",
      displayName: "disabled@example.test",
      status: "disabled",
      accessLevel: "verified_user",
      verifiedAt: "2026-08-01T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(inventory.unknown, ["missing", "unknown"]);
  assert.deepEqual(inventory.excludedHistorical, ["shared_user"]);
});

test("legacy inventory upserts replayable auth users without credentials, sessions, or duplicate events", async () => {
  await withRepository(async (repository) => {
    const rawSnapshot = JSON.stringify({
      users: [
        { id: "one", email: "one@example.test", name: "One", role: "Accountant" },
        { id: "two", email: "two@example.test", name: "Two", role: "Viewer", verifiedAt: "2026-08-01T00:00:00.000Z" },
      ],
    });
    const first = await repository.migrateLegacySnapshot(rawSnapshot, "request-1", "2026-08-10T00:00:00.000Z");
    const second = await repository.migrateLegacySnapshot(rawSnapshot, "request-1", "2026-08-10T00:00:00.000Z");

    assert.deepEqual(first, second);
    assert.deepEqual((await repository.listUsers()).map((user) => ({
      id: user.id,
      status: user.status,
      version: user.version,
      verifiedAt: user.verifiedAt,
    })), [
      { id: "one", status: "invited", version: 1, verifiedAt: null },
      { id: "two", status: "active", version: 1, verifiedAt: "2026-08-01T00:00:00.000Z" },
    ]);
    assert.equal(await repository.countRows("into_auth_credentials"), 0);
    assert.equal(await repository.countRows("into_auth_sessions"), 0);
    assert.equal(await repository.countRows("into_auth_events"), 2);
  });
});

test("auth repositories canonicalize email before unique upsert comparisons", async () => {
  await withRepository(async (repository) => {
    await repository.upsertLegacyUsers([{
      id: "case-user",
      email: "CASE@Example.test",
      displayName: "Case User",
      status: "invited",
      accessLevel: "verified_user",
      verifiedAt: null,
    }], "2026-08-10T00:00:00.000Z");
    await repository.upsertLegacyUsers([{
      id: "case-user",
      email: "case@example.test",
      displayName: "Case User",
      status: "invited",
      accessLevel: "verified_user",
      verifiedAt: null,
    }], "2026-08-10T00:01:00.000Z");
    assert.deepEqual(await repository.listUsers(), [
      {
        id: "case-user",
        email: "case@example.test",
        displayName: "Case User",
        status: "invited",
        accessLevel: "verified_user",
        verifiedAt: null,
        version: 1,
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    ]);
  });
});

test("public auth upserts reject non-ASCII and whitespace email input", async () => {
  await withRepository(async (repository) => {
    for (const email of [" user@example.test", "user@example.test\t", "user@example.test\n", "user@exam\u00a0ple.test", "\u00dcser@example.test"]) {
      await assert.rejects(
        repository.upsertLegacyUsers([{
          id: `bad-${JSON.stringify(email)}`,
          email,
          displayName: "Bad",
          status: "invited",
          accessLevel: "verified_user",
          verifiedAt: null,
        }], "2026-08-10T00:00:00.000Z"),
        AuthEmailValidationError
      );
    }
    assert.equal(await repository.countRows("into_auth_users"), 0);
  });
});

test("SQLite enforces canonical lowercase email storage", async () => {
  await withRepository(async (repository) => {
    const schema = await repository.schemaSql();
    assert.match(schema, /email NOT GLOB '\*\[\^!-~\]\*'/);
  });
});

test("SQLite upgrades an immutable v1 auth fixture to canonical email v2", async () => {
  const path = databasePath();
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE into_auth_schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    );
    INSERT INTO into_auth_schema_migrations VALUES (1, '${SQLITE_AUTH_V1_CHECKSUM}', '2026-08-10T00:00:00.000Z');
    CREATE TABLE into_auth_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL,
      access_level TEXT NOT NULL,
      verified_at TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO into_auth_users VALUES (
      'v1-user', 'V1@Example.test', 'V1', 'invited', 'verified_user', NULL, 1,
      '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
    );
  `);
  database.close();
  const repository = new SqliteAuthRepository(path);
  try {
    await repository.migrate();
    assert.equal(await repository.schemaVersion(), 3);
    assert.equal((await repository.listUsers())[0]?.email, "v1@example.test");
    assert.match(await repository.schemaSql(), /email NOT GLOB '\*\[\^!-~\]\*'/);
  } finally {
    repository.close();
    await rm(path, { force: true });
  }
});

test("SQLite v1 unsupported email input fails before recording v2", async () => {
  for (const email of ["case@example.test\t", "case@example.test\n", "case@exam\u00a0ple.test", "\u00dcser@example.test"]) {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE into_auth_schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO into_auth_schema_migrations VALUES (1, '${SQLITE_AUTH_V1_CHECKSUM}', '2026-08-10T00:00:00.000Z');
      CREATE TABLE into_auth_users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE, display_name TEXT NOT NULL,
        status TEXT NOT NULL, access_level TEXT NOT NULL, verified_at TEXT, version INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    database.prepare("INSERT INTO into_auth_users VALUES (?, ?, 'Bad', 'invited', 'verified_user', NULL, 1, ?, ?)")
      .run("bad", email, "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
    database.close();
    const repository = new SqliteAuthRepository(path);
    try {
      await assert.rejects(repository.migrate(), AuthEmailValidationError);
      assert.equal(await repository.schemaVersion(), 1);
    } finally {
      repository.close();
      await rm(path, { force: true });
    }
  }
});

test("SQLite v1 outer-whitespace collision candidates fail closed without a v2 write", async () => {
  const path = databasePath();
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE into_auth_schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    );
    INSERT INTO into_auth_schema_migrations VALUES (1, '${SQLITE_AUTH_V1_CHECKSUM}', '2026-08-10T00:00:00.000Z');
    CREATE TABLE into_auth_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL,
      access_level TEXT NOT NULL,
      verified_at TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO into_auth_users VALUES
      ('first', ' case@example.test', 'First', 'invited', 'verified_user', NULL, 1, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'),
      ('second', 'case@example.test ', 'Second', 'invited', 'verified_user', NULL, 1, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
  `);
  database.close();
  const repository = new SqliteAuthRepository(path);
  try {
    await assert.rejects(repository.migrate(), AuthEmailValidationError);
    assert.equal(await repository.schemaVersion(), 1);
    assert.deepEqual((await repository.listUsers()).map((user) => user.email), [
      " case@example.test",
      "case@example.test ",
    ]);
  } finally {
    repository.close();
    await rm(path, { force: true });
  }
});

test("raw runtime snapshots retain multiple legacy identities without hydration coercion", async () => {
  const path = databasePath();
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE into_runtime_store (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  database.prepare(
    "INSERT INTO into_runtime_store (id, payload, revision, updated_at) VALUES (?, ?, ?, ?)"
  ).run("company", JSON.stringify({ users: [
    { id: "first", email: "first@example.test", role: "Admin" },
    { id: "second", email: "second@example.test", role: "Viewer" },
  ] }), 1, "2026-08-10T00:00:00.000Z");
  database.close();
  try {
    assert.deepEqual(inventoryRawSqliteSnapshot(path).users.map((user) => user.id), [
      "first",
      "second",
    ]);
  } finally {
    await rm(path, { force: true });
  }
});

test("raw SQLite inventory safely reports no users when legacy storage is absent", async () => {
  const path = databasePath();
  const database = new DatabaseSync(path);
  database.close();
  try {
    assert.deepEqual(inventoryRawSqliteSnapshot(path), {
      users: [],
      unknown: [],
      excludedHistorical: [],
    });
  } finally {
    await rm(path, { force: true });
  }
});

test("legacy inventory coalesces duplicate raw and normalized identities deterministically", () => {
  const inventory = inventoryLegacyUsers({ users: [
    { id: "same", email: "snapshot@example.test", role: "Admin" },
    { id: "same", email: "normalized@example.test", role: "Viewer", verifiedAt: "2026-08-01T00:00:00.000Z" },
  ] });
  assert.deepEqual(inventory.users, [{
    id: "same",
    email: "normalized@example.test",
    displayName: "normalized@example.test",
    status: "active",
    accessLevel: "verified_user",
    verifiedAt: "2026-08-01T00:00:00.000Z",
  }]);
});

test("configured auth storage auto-migrates locally but never in production", async () => {
  const path = databasePath();
  const environment = process.env as Record<string, string | undefined>;
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    mode: process.env.DATABASE_MODE,
    localPath: process.env.LOCAL_DATABASE_PATH,
  };
  try {
    environment.DATABASE_MODE = "sqlite";
    environment.LOCAL_DATABASE_PATH = path;
    environment.NODE_ENV = "test";
    closeConfiguredAuthRepository();
    const local = await configuredAuthRepository();
    assert.equal(await local.schemaVersion(), 3);
    assert.equal(typeof local.migrateLegacyUsers, "function");

    closeConfiguredAuthRepository();
    await rm(path, { force: true });
    environment.NODE_ENV = "production";
    const production = await configuredAuthRepository();
    assert.equal(await production.schemaVersion(), 0);
  } finally {
    closeConfiguredAuthRepository();
    if (previous.nodeEnv === undefined) delete environment.NODE_ENV;
    else environment.NODE_ENV = previous.nodeEnv;
    if (previous.mode === undefined) delete environment.DATABASE_MODE;
    else environment.DATABASE_MODE = previous.mode;
    if (previous.localPath === undefined) delete environment.LOCAL_DATABASE_PATH;
    else environment.LOCAL_DATABASE_PATH = previous.localPath;
    await rm(path, { force: true });
  }
});
