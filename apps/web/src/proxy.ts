import { NextResponse, type NextRequest } from "next/server";
import { hostname, routeFor } from "./lib/hosts";

const ALLOWED_ORIGINS = new Set(
  (process.env.TIMOTIME_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

/** Rozpoznaje adres (time. albo timo-time.) i odpowiada na zapytania wstępne CORS. */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS" && origin && ALLOWED_ORIGINS.has(origin)) {
      return new NextResponse(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "600",
          Vary: "Origin",
        },
      });
    }
    return NextResponse.next();
  }
  const route = routeFor(hostname(request.headers.get("host")), pathname);
  if (route.kind === "rewrite") {
    const url = request.nextUrl.clone();
    url.pathname = route.pathname;
    return NextResponse.rewrite(url);
  }
  if (route.kind === "not-found") {
    const url = request.nextUrl.clone();
    url.pathname = "/__not-found";
    return NextResponse.rewrite(url, { status: 404 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|icon.svg|robots.txt).*)"],
};
