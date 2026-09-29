"use client";

import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/AppSidebar";
import GlobalModals from "@/components/GlobalModals";
import KieBanner from "@/components/KieBanner";
import LocalSessionGuard from "@/components/LocalSessionGuard";
import { IS_LOCAL_MODE } from "@/lib/runtimeConfig";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

interface AppShellProps {
  children: React.ReactNode;
  defaultSidebarOpen: boolean;
}

/**
 * Root layouts persist across App Router navigations. Derive the chrome from
 * the live pathname so an expired owner session cannot leave authenticated UI
 * mounted around the login page after proxy redirects the current navigation.
 */
export default function AppShell({ children, defaultSidebarOpen }: AppShellProps) {
  const pathname = usePathname();

  if (pathname === "/login" || pathname.startsWith("/login/")) {
    return children;
  }

  return (
    <>
      {IS_LOCAL_MODE && <LocalSessionGuard />}
      <TooltipProvider>
        <SidebarProvider defaultOpen={defaultSidebarOpen} className="h-full">
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
  );
}
