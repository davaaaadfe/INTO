import {
  withVerifiedPersistentRequest,
} from "../../../../lib/services/verified-session-auth";

export async function GET(request: Request) {
  return withVerifiedPersistentRequest(request, () =>
    Response.json({ authenticated: true })
  );
}
