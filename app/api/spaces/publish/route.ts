import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { IS_LOCAL_MODE } from "@/lib/runtimeConfig";

export async function POST(req: NextRequest) {
  if (IS_LOCAL_MODE) {
    return NextResponse.json(
      { error: "Workflow sharing is not available in local mode yet." },
      { status: 501 },
    );
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { id, isPublic } = body as { id: string; isPublic: boolean };
  if (!id || typeof isPublic !== "boolean") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { error } = await supabase
    .from("spaces")
    .update({ is_public: isPublic })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
