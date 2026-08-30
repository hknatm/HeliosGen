"use client";

import { Node, NodeProps } from "@xyflow/react";
import { NodeData } from "@/lib/store";
import { BRAND_PROFILE_NODE, getProfileConfig } from "@/lib/profileNodes";
import ProfileDataNode from "./ProfileDataNode";

type BrandProfileNodeType = Node<NodeData, "brandProfileNode">;

export default function BrandProfileNode({ id, data, selected }: NodeProps<BrandProfileNodeType>) {
  const config = getProfileConfig(BRAND_PROFILE_NODE)!;
  return <ProfileDataNode id={id} data={data} selected={selected} config={config} />;
}
