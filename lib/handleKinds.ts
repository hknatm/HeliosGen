/** One colour vocabulary for node connections. Used by typed handles and labels. */
export type HandleKind = "prompt" | "images" | "context" | "report";

export const HANDLE_KINDS: Record<HandleKind, { color: string; label: string; hint: string }> = {
  prompt:  { color: "#2DD4BF", label: "PROMPT",  hint: "Text" },
  images:  { color: "#fb923c", label: "IMAGES",  hint: "Images" },
  context: { color: "#a78bfa", label: "CONTEXT", hint: "Variables, Brand or Style" },
  report:  { color: "#FBBF24", label: "OUTPUT",  hint: "Generated text" },
};
