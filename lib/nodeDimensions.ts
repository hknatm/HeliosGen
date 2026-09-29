export interface FinalNodeResizeChange {
  type: string;
  id?: string;
  resizing?: boolean;
  dimensions?: { width: number; height: number };
}

interface PersistableNodeSize {
  id: string;
  width?: number;
  height?: number;
  style?: object;
}

/**
 * React Flow's NodeResizeControl final change updates `measured` dimensions but
 * does not set `width`/`height` attributes. Persist those dimensions explicitly
 * so remounts and workflow reloads keep the user-resized node bounds.
 */
export function persistFinalNodeResize<T extends PersistableNodeSize>(
  nodes: T[],
  changes: FinalNodeResizeChange[],
): T[] {
  const finalSizes = new Map<string, { width: number; height: number }>();
  for (const change of changes) {
    if (
      change.type !== "dimensions" ||
      !change.id ||
      change.resizing !== false ||
      !change.dimensions ||
      !Number.isFinite(change.dimensions.width) ||
      !Number.isFinite(change.dimensions.height) ||
      change.dimensions.width <= 0 ||
      change.dimensions.height <= 0
    ) continue;
    finalSizes.set(change.id, change.dimensions);
  }
  if (!finalSizes.size) return nodes;
  return nodes.map((node) => {
    const size = finalSizes.get(node.id);
    return size
      ? { ...node, width: size.width, height: size.height, style: { ...node.style, ...size } }
      : node;
  });
}
