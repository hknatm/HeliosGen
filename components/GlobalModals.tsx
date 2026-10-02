"use client";
import AuthModal from "@/components/AuthModal";
import ResetPasswordModal from "@/components/ResetPasswordModal";
import dynamic from "next/dynamic";
import Toaster from "@/components/Toaster";
import { useWorkflowStore } from "@/lib/store";

// Settings is large and only opens on demand, so it loads as its own chunk.
const SettingsModal = dynamic(() => import("@/components/SettingsModal"), { ssr: false });

export default function GlobalModals() {
  const settingsOpen    = useWorkflowStore((s) => s.settingsOpen);
  const setSettingsOpen = useWorkflowStore((s) => s.setSettingsOpen);

  return (
    <>
      <AuthModal />
      <ResetPasswordModal />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <Toaster />
    </>
  );
}
