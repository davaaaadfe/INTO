import { withVerifiedPersistentRequest } from "../../../../lib/services/verified-session-auth";

export async function POST(request: Request) {
  return withVerifiedPersistentRequest(request, () =>
    Response.json({ error: "Not found." }, { status: 404 })
  );
}
