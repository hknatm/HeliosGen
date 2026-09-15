import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { GUEST_MODE } from "@/lib/guestMode";
import { LOCAL_SESSION_COOKIE, localAuthConfigured, safeNextPath, verifyLocalSession, verifyProviderAssetAccess } from "@/lib/localAuth";

const PUBLIC_LOCAL_PATHS = new Set([
  "/login",
  "/api/auth/local-login",
  "/api/auth/local-logout",
  "/api/callback",
  "/favicon.ico",
  "/HG.svg",
]);

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function proxy(request: NextRequest) {
  if (GUEST_MODE) {
    const path = request.nextUrl.pathname;
    const optimizedAsset = request.nextUrl.searchParams.get("url");
    const isLoginImage = path === "/_next/image" && optimizedAsset === "/HG.svg";
    const isPublic = PUBLIC_LOCAL_PATHS.has(path) || path.startsWith("/_next/static/") || isLoginImage;
    const configured = localAuthConfigured();
    const authenticated = configured && verifyLocalSession(request.cookies.get(LOCAL_SESSION_COOKIE)?.value);
    const providerAssetAccess = verifyProviderAssetAccess(
      path,
      request.nextUrl.searchParams.get("provider_expires"),
      request.nextUrl.searchParams.get("provider_token"),
    );

    if (path === "/login" && authenticated) {
      return noStore(NextResponse.redirect(new URL("/gallery?tab=images", request.url)));
    }
    if (path === "/login") {
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set("x-helios-login-page", "1");
      return noStore(NextResponse.next({ request: { headers: requestHeaders } }));
    }
    if (isPublic || providerAssetAccess) return noStore(NextResponse.next({ request }));

    if (!authenticated) {
      if (path === "/_next/image") {
        return new NextResponse(null, { status: 401, headers: { "Cache-Control": "no-store" } });
      }
      if (path.startsWith("/api/")) {
        return NextResponse.json(
          { error: configured ? "Unauthorized" : "Local authentication is not configured." },
          { status: configured ? 401 : 503, headers: { "Cache-Control": "no-store" } },
        );
      }
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("next", safeNextPath(`${path}${request.nextUrl.search}`));
      return noStore(NextResponse.redirect(loginUrl));
    }

    const requestHeaders = new Headers(request.headers);
    requestHeaders.delete("x-helios-login-page");
    return noStore(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  const cloudHeaders = new Headers(request.headers);
  cloudHeaders.delete("x-helios-login-page");
  if (request.nextUrl.pathname === "/_next/image" || request.nextUrl.pathname === "/api/callback" || request.nextUrl.pathname === "/api/upload-to-r2") {
    return NextResponse.next({ request: { headers: cloudHeaders } });
  }
  let supabaseResponse = NextResponse.next({ request: { headers: cloudHeaders } });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request: { headers: cloudHeaders } });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  await supabase.auth.getUser();
  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|favicon.ico).*)",
  ],
};
