import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("dual legacy bootstrap exposes the invite-only Users view without fabricating an actor", async () => {
  const [workbench, usersPanel] = await Promise.all([
    readFile("components/into-workbench.tsx", "utf8"),
    readFile("components/into-users-panel.tsx", "utf8"),
  ]);

  assert.match(workbench, /canInviteUsers/);
  assert.match(workbench, /actor \|\| canInviteUsers/);
  assert.match(workbench, /<IntoUsersPanel bootstrapOnly=\{!actor\}/);
  assert.match(usersPanel, /bootstrapOnly/);
  assert.match(usersPanel, /if \(!bootstrapOnly\)/);
});
