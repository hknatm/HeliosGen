import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createClient } from "@/lib/supabase/client";

export const IS_LOCAL_CLIENT =
  process.env.NEXT_PUBLIC_HELIOS_MODE === "local" ||
  process.env.NEXT_PUBLIC_GUEST_MODE === "true";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: StoredMessage[];
  model: string;
  createdAt: number;
  updatedAt: number;
}

interface ChatSessionState {
  sessions: ChatSession[];
  preferredModel: string;
  setPreferredModel: (model: string) => void;
  createSession: (model: string, title: string) => string;
  upsertSession: (id: string, messages: StoredMessage[], model: string) => void;
  deleteSession: (id: string) => void;
  loadFromSupabase: () => Promise<void>;
  clearSessions: () => void;
}

async function getAuthenticatedUser() {
  const supabase = createClient();
  const { data } = await supabase.auth.getUser();
  return { supabase, user: data.user };
}

/** Persists a chat session to the shared SQLite DB (local mode only). */
async function persistChatSession(session: ChatSession) {
  try {
    await fetch("/api/chat-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          id: session.id,
          title: session.title,
          messages: session.messages,
          model: session.model,
          created_at: new Date(session.createdAt).toISOString(),
          updated_at: new Date(session.updatedAt).toISOString(),
        },
      }),
    });
  } catch { /* offline / transient — ignore */ }
}

export const useChatSessionStore = create<ChatSessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      preferredModel: "claude-sonnet-4-6",

      setPreferredModel: (model) => set({ preferredModel: model }),

      createSession: (model, title) => {
        const id = crypto.randomUUID();
        const now = Date.now();
        set(s => ({
          sessions: [
            { id, title, messages: [], model, createdAt: now, updatedAt: now },
            ...s.sessions,
          ],
        }));

        if (IS_LOCAL_CLIENT) {
          persistChatSession({ id, title, messages: [], model, createdAt: now, updatedAt: now });
          return id;
        }

        getAuthenticatedUser().then(({ supabase, user }) => {
          if (!user) return;
          supabase.from("chat_sessions").insert({
            id,
            user_id: user.id,
            title,
            messages: [],
            model,
            created_at: new Date(now).toISOString(),
            updated_at: new Date(now).toISOString(),
          }).then(({ error }) => { if (error) console.error("[chat] insert:", error.message); });
        });

        return id;
      },

      upsertSession: (id, messages, model) => {
        const updatedAt = Date.now();
        set(s => ({
          sessions: s.sessions.map(sess =>
            sess.id === id ? { ...sess, messages, model, updatedAt } : sess
          ),
        }));

        if (IS_LOCAL_CLIENT) {
          const sess = get().sessions.find(s => s.id === id);
          if (sess) persistChatSession({ ...sess, messages, model, updatedAt });
          return;
        }

        getAuthenticatedUser().then(({ supabase, user }) => {
          if (!user) return;
          supabase.from("chat_sessions").upsert({
            id,
            user_id: user.id,
            title: get().sessions.find(s => s.id === id)?.title ?? "Chat",
            messages,
            model,
            updated_at: new Date(updatedAt).toISOString(),
          }).then(({ error }) => { if (error) console.error("[chat] upsert:", error.message); });
        });
      },

      deleteSession: (id) => {
        set(s => ({ sessions: s.sessions.filter(sess => sess.id !== id) }));

        if (IS_LOCAL_CLIENT) {
          fetch(`/api/chat-sessions?id=${encodeURIComponent(id)}`, { method: "DELETE" })
            .catch(() => {});
          return;
        }

        getAuthenticatedUser().then(({ supabase, user }) => {
          if (!user) return;
          supabase.from("chat_sessions").delete().eq("id", id)
            .then(({ error }) => { if (error) console.error("[chat] delete:", error.message); });
        });
      },

      clearSessions: () => set({ sessions: [] }),

      loadFromSupabase: async () => {
        // ── Local mode: shared SQLite via /api/chat-sessions ───────────────────
        if (IS_LOCAL_CLIENT) {
          let res: Response;
          try {
            res = await fetch("/api/chat-sessions");
          } catch {
            return;
          }
          if (!res.ok) return;
          const data = (await res.json().catch(() => null)) as { sessions?: unknown[] } | null;
          const serverSessions: ChatSession[] = (data?.sessions ?? []).map((row) => {
            const r = row as {
              id: string; title: string; messages: StoredMessage[];
              model: string; created_at: string; updated_at: string;
            };
            return {
              id: r.id,
              title: r.title,
              messages: Array.isArray(r.messages) ? r.messages : [],
              model: r.model,
              createdAt: new Date(r.created_at).getTime(),
              updatedAt: new Date(r.updated_at).getTime(),
            };
          });

          // Merge by timestamp. This imports old browser-only sessions and
          // retains an unsent local edit if the previous POST was interrupted.
          const byId = new Map(serverSessions.map((session) => [session.id, session]));
          for (const local of get().sessions) {
            const remote = byId.get(local.id);
            if (!remote || local.updatedAt > remote.updatedAt) {
              byId.set(local.id, local);
              persistChatSession(local);
            }
          }

          set({ sessions: [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt) });
          return;
        }

        const { supabase, user } = await getAuthenticatedUser();
        if (!user) return;

        // Upload any local sessions with messages that aren't in Supabase yet
        const local = get().sessions.filter(s => s.messages.length > 0);
        if (local.length > 0) {
          const { data: existing } = await supabase
            .from("chat_sessions")
            .select("id")
            .in("id", local.map(s => s.id));
          const existingIds = new Set((existing ?? []).map((r: { id: string }) => r.id));
          const toUpload = local.filter(s => !existingIds.has(s.id));
          if (toUpload.length > 0) {
            await supabase.from("chat_sessions").insert(
              toUpload.map(s => ({
                id: s.id,
                user_id: user.id,
                title: s.title,
                messages: s.messages,
                model: s.model,
                created_at: new Date(s.createdAt).toISOString(),
                updated_at: new Date(s.updatedAt).toISOString(),
              }))
            );
          }
        }

        // Fetch all sessions from Supabase
        const { data, error } = await supabase
          .from("chat_sessions")
          .select("*")
          .order("updated_at", { ascending: false });

        if (error) { console.error("[chat] load:", error.message); return; }

        set({
          sessions: (data ?? []).map((row: {
            id: string; title: string; messages: StoredMessage[];
            model: string; created_at: string; updated_at: string;
          }) => ({
            id: row.id,
            title: row.title,
            messages: row.messages,
            model: row.model,
            createdAt: new Date(row.created_at).getTime(),
            updatedAt: new Date(row.updated_at).getTime(),
          })),
        });
      },
    }),
    {
      name: process.env.NEXT_PUBLIC_GUEST_MODE === "true" ? "heliosgen-chats-guest" : "heliosgen-chats",
      storage: createJSONStorage(() => localStorage),
    }
  )
);
