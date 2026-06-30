import {
  currentUserContext,
  listUsers,
  switchCurrentUser,
} from "../../../lib/repository/invoice-store";

export async function GET() {
  return Response.json({
    users: listUsers(),
    currentUser: currentUserContext().user,
    permissions: currentUserContext().permissions,
  });
}

export async function POST(request: Request) {
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
}
