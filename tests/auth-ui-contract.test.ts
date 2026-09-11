import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntoPasswordScreen } from "../components/into-password-screen";
import { IntoWorkbench } from "../components/into-workbench";
import VerifyPage from "../app/verify/page";

test("the entrance requests only the shared password even with obsolete auth mode props", () => {
  for (const mode of ["legacy_password", "dual", "verified_user"] as const) {
    const props = { configured: true, mode };
    const markup = renderToStaticMarkup(createElement(IntoPasswordScreen, props));
    const inputs = markup.match(/<input\b[^>]*>/g) ?? [];
    assert.equal(inputs.length, 1, mode);
    assert.match(inputs[0], /type="password"/);
    assert.match(markup, /Enter INTO password/);
    assert.doesNotMatch(markup, /Email|Display name|Verify your account/);
  }
});

test("an unconfigured password entrance stays locked and explains the server configuration", () => {
  const markup = renderToStaticMarkup(createElement(IntoPasswordScreen, { configured: false }));
  assert.match(markup, /<input\b[^>]*disabled=""/);
  assert.match(markup, /<button\b[^>]*disabled=""/);
  assert.match(markup, /role="alert"/);
  assert.match(markup, /INTO_ACCESS_PASSWORD/);
});

test("the shared workbench offers Lock INTO and invoice views without account controls", () => {
  const markup = renderToStaticMarkup(createElement(IntoWorkbench));
  assert.match(markup, /Lock INTO/);
  assert.match(markup, /Processing queue/);
  assert.match(markup, /Invoice archive/);
  assert.doesNotMatch(markup, />Users<|Signed in as|Logout|Invite|Display name/);
});

test("obsolete verification links redirect home without consuming their token", async () => {
  let readSearchParams = false;
  const props = {
    get searchParams() {
      readSearchParams = true;
      return Promise.resolve({ token: "old-invitation-token" });
    },
  };
  await assert.rejects(
    async () => Reflect.apply(VerifyPage, undefined, [props]),
    (error: unknown) => error instanceof Error &&
      "digest" in error && error.digest === "NEXT_REDIRECT;replace;/;307;"
  );
  assert.equal(readSearchParams, false);
});
