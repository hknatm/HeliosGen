export type WorkflowVariableType = "text" | "number" | "boolean" | "json";

export interface WorkflowVariableField {
  id: string;
  key: string;
  value: string;
  type: WorkflowVariableType;
}

export interface ResolvedWorkflowVariable {
  key: string;
  value: string;
  sourceId: string;
  sourceLabel: string;
}

export const VARIABLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeVariableKey(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function isValidVariableKey(key: string): boolean {
  return VARIABLE_KEY_PATTERN.test(key);
}

export function serializeVariableValue(field: Pick<WorkflowVariableField, "type" | "value">): string {
  if (field.type !== "json") return field.value;
  try { return JSON.stringify(JSON.parse(field.value)); } catch { return field.value; }
}

export function resolveWorkflowTemplate(
  template: string,
  variables: ResolvedWorkflowVariable[],
): { resolved: string; missingKeys: string[]; duplicateKeys: string[] } {
  const counts = new Map<string, number>();
  const valueByKey = new Map<string, string>();
  for (const variable of variables) {
    counts.set(variable.key, (counts.get(variable.key) ?? 0) + 1);
    if (!valueByKey.has(variable.key)) valueByKey.set(variable.key, variable.value);
  }

  const duplicateKeys = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();
  const missingKeys = new Set<string>();
  const duplicateSet = new Set(duplicateKeys);

  const resolved = template.replace(/{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}/g, (token, key: string) => {
    if (duplicateSet.has(key) || !valueByKey.has(key)) {
      missingKeys.add(key);
      return token;
    }
    return valueByKey.get(key)!;
  });

  return { resolved, missingKeys: [...missingKeys].sort(), duplicateKeys };
}
