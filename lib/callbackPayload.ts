type CallbackData = {
  resultJson?: unknown;
  videoUrl?: unknown;
  output?: unknown;
};

const URL_KEYS = ["resultUrls", "resultUrl", "imageUrls", "imageUrl", "fileUrl", "url", "urls"] as const;

function collectUrls(value: unknown, output: string[], depth = 0): void {
  if (depth > 4 || value == null) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        collectUrls(JSON.parse(trimmed), output, depth + 1);
        return;
      } catch {
        // A non-JSON string may itself be a URL.
      }
    }
    output.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  let matched = false;
  for (const key of URL_KEYS) {
    if (!(key in record)) continue;
    matched = true;
    collectUrls(record[key], output, depth + 1);
  }
  if (!matched && "data" in record) collectUrls(record.data, output, depth + 1);
}

export function callbackOutputUrls(data: CallbackData): string[] {
  const candidates: string[] = [];
  collectUrls(data.resultJson, candidates);
  collectUrls(data.videoUrl, candidates);
  collectUrls(data.output, candidates);

  return [...new Set(candidates)].filter((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  });
}
