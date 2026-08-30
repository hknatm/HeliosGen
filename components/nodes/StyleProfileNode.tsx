"use client";

import { Node, NodeProps } from "@xyflow/react";
import { NodeData } from "@/lib/store";
import { STYLE_PROFILE_NODE, getProfileConfig } from "@/lib/profileNodes";
import ProfileDataNode from "./ProfileDataNode";

type StyleProfileNodeType = Node<NodeData, "styleProfileNode">;

export default function StyleProfileNode({ id, data, selected }: NodeProps<StyleProfileNodeType>) {
  const config = getProfileConfig(STYLE_PROFILE_NODE)!;
  return <ProfileDataNode id={id} data={data} selected={selected} config={config} />;
}
