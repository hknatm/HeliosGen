import Image from "next/image";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import LoginForm from "./LoginForm";
import { IS_LOCAL_MODE } from "@/lib/runtimeConfig";
import { LOCAL_SESSION_COOKIE, localAuthConfigured, safeNextPath, verifyLocalSession } from "@/lib/localAuth";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  if (!IS_LOCAL_MODE) redirect("/");
  const params = await searchParams;
  const cookieStore = await cookies();
  const nextPath = safeNextPath(params.next);
  if (verifyLocalSession(cookieStore.get(LOCAL_SESSION_COOKIE)?.value)) redirect(nextPath);

  const configured = localAuthConfigured();
  return (
    <main className="login-page min-h-screen overflow-auto px-5 py-10 sm:grid sm:place-items-center">
      <section aria-labelledby="login-title" className="mx-auto w-full max-w-md">
        <div className="flex items-center gap-3">
          <Image src="/HG.svg" alt="" width={40} height={40} priority unoptimized />
          <span className="text-sm font-semibold tracking-wide text-foreground/70">HeliosGen</span>
        </div>
        <h1 id="login-title" className="mt-10 text-3xl font-semibold tracking-[-0.03em] text-foreground">Welcome back</h1>
        <p className="mt-3 max-w-[42ch] text-sm leading-6 text-muted-foreground">Sign in to your private creative workspace. Generated media, workflows, settings, and API access remain protected behind this owner session.</p>
        {configured ? (
          <LoginForm nextPath={nextPath} />
        ) : (
          <div role="alert" className="mt-8 rounded-xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100">
            Local authentication is not configured. Set <code>HELIOS_ADMIN_PASSWORD_HASH</code> and <code>HELIOS_SESSION_SECRET</code> on the server, then restart HeliosGen.
          </div>
        )}
        <p className="mt-8 text-xs leading-5 text-muted-foreground">Single-owner access · Secure, HTTP-only session cookie</p>
      </section>
    </main>
  );
}
