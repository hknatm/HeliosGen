// Centralized schema/defaults + namespace mapping for pure structured
// profile nodes (Brand Context, Image Style Profile).
//
// These nodes are pure structured data: they never wire directly to prompt or
// generation inputs. Their only functional connection is to a Prompt Composer
// node's `variables` target handle, where fields are exposed as namespaced
// tokens (`brand.*` / `style.*`). Variable nodes stay unprefixed.
import type { WorkflowVariableField } from "./workflowVariables";

export const BRAND_PROFILE_NODE = "brandProfileNode";
export const STYLE_PROFILE_NODE = "styleProfileNode";

export interface ProfileNodeConfig {
  /** React Flow node type id ("brandProfileNode" | "styleProfileNode"). */
  type: string;
  /** Namespace applied to emitted tokens, e.g. "brand" / "style". */
  namespace: string;
  /** Token prefix including the trailing dot, e.g. "brand." / "style.". */
  tokenPrefix: string;
  /** User-facing node name. */
  displayName: string;
  /** Short subtitle for the node header. */
  subtitle: string;
  /** Accent color used throughout the editor UI. */
  accent: string;
  /** Soft translucent accent for icon chips / buttons. */
  accentBg: string;
  /** Brighter accent text color. */
  accentText: string;
  /** Prefix for auto-generated field ids (kept unique per node class). */
  fieldIdPrefix: string;
  /** Canonical initial fields shown when a new node has no saved data. */
  defaultFields: WorkflowVariableField[];
}

/** Canonical default fields for a newly created Brand Context node. */
const BRAND_DEFAULT_FIELDS: WorkflowVariableField[] = [
  { id: "brand-name",            key: "brand_name",     value: "Aurora Home",        type: "text" },
  { id: "brand-primary-color",   key: "primary_color",  value: "#2F6B5F",            type: "color" },
  { id: "brand-accent-color",    key: "accent_color",   value: "#F59E0B",            type: "color" },
  { id: "brand-voice",           key: "voice",          value: "Warm and approachable", type: "text" },
  { id: "brand-visual-rules",    key: "visual_rules",   value: "Clean studio sweep", type: "text" },
  { id: "brand-avoid",           key: "avoid",          value: "Visible text, logos, clutter", type: "text" },
];

/** Canonical default fields for a newly created Image Style Profile node. */
const STYLE_DEFAULT_FIELDS: WorkflowVariableField[] = [
  { id: "style-profile-name",     key: "profile_name",     value: "Premium product listing",                     type: "text" },
  { id: "style-shot-type",        key: "shot_type",        value: "Product hero shot",                            type: "text" },
  { id: "style-composition",      key: "composition",      value: "Single centered subject, generous negative space", type: "text" },
  { id: "style-camera",           key: "camera",           value: "85mm, eye level",                              type: "text" },
  { id: "style-lighting",         key: "lighting",         value: "Soft directional daylight",                    type: "text" },
  { id: "style-background",       key: "background",       value: "Clean studio sweep",                           type: "text" },
  { id: "style-props",            key: "props",            value: "Minimal, no clutter",                          type: "text" },
  { id: "style-color-treatment",  key: "color_treatment",  value: "Natural, true-to-life color",                  type: "text" },
  { id: "style-output-intent",    key: "output_intent",    value: "High-resolution listing-ready output",         type: "text" },
  { id: "style-avoid",            key: "avoid",            value: "Visible text, logos, clutter",                 type: "text" },
];

export const PROFILE_NODE_CONFIGS: Record<string, ProfileNodeConfig> = {
  [BRAND_PROFILE_NODE]: {
    type: BRAND_PROFILE_NODE,
    namespace: "brand",
    tokenPrefix: "brand.",
    displayName: "Brand Context",
    subtitle: "Reusable style context as structured JSON",
    accent: "#2dd4bf",
    accentBg: "rgba(45,212,191,0.14)",
    accentText: "#5eead4",
    fieldIdPrefix: "brand",
    defaultFields: BRAND_DEFAULT_FIELDS,
  },
  [STYLE_PROFILE_NODE]: {
    type: STYLE_PROFILE_NODE,
    namespace: "style",
    tokenPrefix: "style.",
    displayName: "Image Style Profile",
    subtitle: "Image style instructions as structured data",
    accent: "#38bdf8",
    accentBg: "rgba(56,189,248,0.14)",
    accentText: "#7dd3fc",
    fieldIdPrefix: "style",
    defaultFields: STYLE_DEFAULT_FIELDS,
  },
};

/** Config for a profile node type, or undefined for non-profile nodes. */
export function getProfileConfig(type: string | undefined | null): ProfileNodeConfig | undefined {
  return type ? PROFILE_NODE_CONFIGS[type] : undefined;
}

/** True if the node type is a structured profile node (Brand Context / Image Style Profile). */
export function isProfileNode(type: string | undefined | null): boolean {
  return !!getProfileConfig(type);
}

/** Namespaced token prefix ("brand." / "style."), or "" for variables/unprofiled sources. */
export function profileTokenPrefix(type: string | undefined | null): string {
  return getProfileConfig(type)?.tokenPrefix ?? "";
}
