import { NextResponse } from "next/server";
import { INTO_ACCESS_COOKIE_NAME } from "../../../../lib/services/into-access-auth";

export function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: INTO_ACCESS_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
