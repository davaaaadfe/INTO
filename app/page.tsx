import { cookies } from "next/headers";
import { IntoWorkbench } from "../components/into-workbench";
import { IntoPasswordScreen } from "../components/into-password-screen";
import {
  INTO_ACCESS_COOKIE_NAME,
  isIntoAccessPasswordConfigured,
  verifyIntoAccessSession,
} from "../lib/services/into-access-auth";

export default async function Home() {
  const configured = isIntoAccessPasswordConfigured();
  const session = (await cookies()).get(INTO_ACCESS_COOKIE_NAME)?.value;

  if (!configured || !verifyIntoAccessSession(session)) {
    return <IntoPasswordScreen configured={configured} />;
  }

  return <IntoWorkbench />;
}
