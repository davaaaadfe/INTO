import { NextResponse } from "next/server";
import { INTO_ACCESS_COOKIE_NAME } from "../../../../lib/services/into-access-auth";
import {
  RequestAuthenticationError,
  requireSameOrigin,
  VERIFIED_SESSION_COOKIE_NAME,
} from "../../../../lib/services/verified-session-auth";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
  } catch (error) {
    if (error instanceof RequestAuthenticationError) {
      return NextResponse.json({ error: "Access denied." }, { status: error.status });
    }
    throw error;
  }
  const response = NextResponse.json({ ok: true });
  for (const name of [INTO_ACCESS_COOKIE_NAME, VERIFIED_SESSION_COOKIE_NAME]) {
    response.cookies.set({
      name,
      value: "",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  }
  return response;
}
