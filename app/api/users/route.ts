import {
  currentUserContext,
  listUsers,
  switchCurrentUser,
} from "../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../lib/repository/persistent-request";

export async function GET() {
  return withPersistentStore(() => {
    const context = currentUserContext();
    return Response.json({
      users: listUsers(),
      currentUser: context.user,
      permissions: context.permissions,
    });
  });
}

export async function POST(request: Request) {
  return withPersistentStore(async () => {
    const payload = (await request.json()) as { userId?: string };
    const context = switchCurrentUser(payload.userId ?? "");

    if (!context) {
      return Response.json({ error: "User not found or disabled." }, { status: 404 });
    }

    return Response.json({
      users: listUsers(),
      currentUser: context.user,
      permissions: context.permissions,
    });
  });
}
