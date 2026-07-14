import { NextResponse } from "next/server";
import {
  createIntoAccessSession,
  INTO_ACCESS_COOKIE_NAME,
  INTO_ACCESS_SESSION_SECONDS,
  isIntoAccessPasswordConfigured,
  verifyIntoAccessPassword,
} from "../../../../lib/services/into-access-auth";

const missingConfigurationMessage =
  "INTO access password is not configured. Add INTO_ACCESS_PASSWORD in Vercel Environment Variables.";

export async function POST(request: Request) {
  if (!isIntoAccessPasswordConfigured()) {
    return NextResponse.json(
      { error: missingConfigurationMessage },
      { status: 503 }
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    password?: unknown;
  } | null;
  const password = typeof payload?.password === "string" ? payload.password : "";

  if (!verifyIntoAccessPassword(password)) {
    return NextResponse.json(
      { error: "The password is incorrect. Please try again." },
      { status: 401 }
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: INTO_ACCESS_COOKIE_NAME,
    value: createIntoAccessSession(),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: INTO_ACCESS_SESSION_SECONDS,
  });
  return response;
}
