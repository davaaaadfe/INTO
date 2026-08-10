import { cookies } from "next/headers";
import { IntoWorkbench } from "../components/into-workbench";
import { IntoPasswordScreen } from "../components/into-password-screen";
import {
  INTO_ACCESS_COOKIE_NAME,
  isIntoAccessPasswordConfigured,
  verifyIntoAccessSession,
} from "../lib/services/into-access-auth";
import { configuredAuthRepository } from "../lib/repository/configured-auth-repository";
import {
  parseAuthMode,
  resolveVerifiedPrincipal,
  VERIFIED_SESSION_COOKIE_NAME,
} from "../lib/services/verified-session-auth";

export default async function Home() {
  const mode = parseAuthMode();
  const configured = isIntoAccessPasswordConfigured();
  const cookieStore = await cookies();
  const session = cookieStore.get(INTO_ACCESS_COOKIE_NAME)?.value;
  const verifiedToken = cookieStore.get(VERIFIED_SESSION_COOKIE_NAME)?.value;
  let verified = false;
  if (mode !== "legacy_password" && verifiedToken) {
    try {
      await resolveVerifiedPrincipal(new Request("http://localhost/", {
        headers: { cookie: `${VERIFIED_SESSION_COOKIE_NAME}=${encodeURIComponent(verifiedToken)}` },
      }), { repository: await configuredAuthRepository() });
      verified = true;
    } catch {
      verified = false;
    }
  }

  const legacy = mode !== "verified_user" && configured && verifyIntoAccessSession(session);
  if (!verified && !legacy) {
    return <IntoPasswordScreen configured={mode !== "legacy_password" || configured} mode={mode} />;
  }

  return <IntoWorkbench />;
}
