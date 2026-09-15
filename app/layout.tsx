import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Doto } from "next/font/google";
import "./globals.css";
import { AppSidebar } from "@/components/AppSidebar";
import GlobalModals from "@/components/GlobalModals";
import KieBanner from "@/components/KieBanner";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
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
        {loginPage ? children : (
          <>
            <TooltipProvider>
              <SidebarProvider defaultOpen={sidebarOpen} className="h-full">
                <AppSidebar />
                <SidebarInset style={{ backgroundColor: "transparent" }} className="app-main-panel flex flex-col min-h-0 min-w-0 border mx-2 mt-2 rounded-tl-xl rounded-tr-xl">
                  <KieBanner />
                  <div className="md:hidden flex items-center h-10 px-3 border-b border-white/[0.08] shrink-0">
                    <SidebarTrigger className="text-white/50 hover:text-white hover:bg-white/[0.05] transition-colors rounded-lg p-1.5 [&_svg]:size-4" />
                  </div>
                  {children}
                </SidebarInset>
              </SidebarProvider>
            </TooltipProvider>
            <GlobalModals />
          </>
        )}
      </body>
    </html>
  );
}
