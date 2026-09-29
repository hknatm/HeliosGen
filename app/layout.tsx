import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Doto } from "next/font/google";
import "./globals.css";
import AppShell from "@/components/AppShell";
import { cookies, headers } from "next/headers";
import ThemeProvider from "@/components/ThemeProvider";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const doto = Doto({
  variable: "--font-doto",
  subsets: ["latin"],
  weight: ["900"],
});

export const metadata: Metadata = {
  title: "HeliosGen",
  description: "Build AI image & video generation workflows visually",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const loginPage = requestHeaders.get("x-helios-login-page") === "1";
  const sidebarOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${doto.variable} antialiased dark`}
      data-theme="dark"
      suppressHydrationWarning
      style={{ height: "100%", colorScheme: "dark" }}
    >
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} /></head>
      <body className="app-shell h-full overflow-hidden">
        <ThemeProvider />
        {loginPage ? children : <AppShell defaultSidebarOpen={sidebarOpen}>{children}</AppShell>}
      </body>
    </html>
  );
}
