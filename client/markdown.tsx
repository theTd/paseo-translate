import { useMemo } from "react";
import { Linking, Platform, Text, View } from "react-native";
import {
  parseMarkdownBlocks,
  type BlockNode,
  type InlineNode,
} from "./markdown-parse";

export interface MarkdownColors {
  foreground: string;
  accent: string;
}

const CODE_BACKGROUND = "rgba(127, 127, 127, 0.15)";
const MONOSPACE = Platform.OS === "ios" ? "Menlo" : "monospace";

/**
 * Dependency-free Markdown view for translated (and original) assistant
 * text. The daemon's client compiler rejects Node builtins anywhere in the
 * client import graph, which rules out the usual markdown packages, so this
 * renders the parser AST with plain React Native primitives. Styling stays
 * theme-agnostic: text follows the host theme, code uses a translucent fill
 * that reads on light and dark themes alike.
 */
export function MarkdownView({ text, colors }: { text: string; colors: MarkdownColors }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return (
    <View>
      {blocks.map((block, index) => (
        <Block key={index} node={block} colors={colors} />
      ))}
    </View>
  );
}

function Block({ node, colors }: { node: BlockNode; colors: MarkdownColors }) {
  switch (node.type) {
    case "paragraph":
      return (
        // selectable keeps translated text copyable on every host: native
        // has no inherited selectability, and on web it opts the node into
        // user-select:text next to the host's plugin surface. Inline children
        // stay plain so each block remains a single native selection scope.
        <Text selectable style={{ color: colors.foreground, marginBottom: 8 }}>
          <Inline nodes={node.children} colors={colors} />
        </Text>
      );
    case "heading": {
      const sizes = [22, 19, 17, 15, 14, 13];
      return (
        <Text
          selectable
          style={{
            color: colors.foreground,
            fontSize: sizes[node.level - 1] ?? 14,
            fontWeight: "700",
            marginTop: 10,
            marginBottom: 6,
          }}
        >
          <Inline nodes={node.children} colors={colors} />
        </Text>
      );
    }
    case "codeblock":
      return (
        <View
          style={{
            backgroundColor: CODE_BACKGROUND,
            borderRadius: 6,
            padding: 8,
            marginBottom: 8,
          }}
        >
          <Text
            selectable
            style={{ color: colors.foreground, fontFamily: MONOSPACE, fontSize: 12.5 }}
          >
            {node.text}
          </Text>
        </View>
      );
    case "quote":
      return (
        <View
          style={{
            borderLeftWidth: 3,
            borderLeftColor: colors.accent,
            paddingLeft: 8,
            marginBottom: 8,
          }}
        >
          {node.children.map((child, index) => (
            <Block key={index} node={child} colors={colors} />
          ))}
        </View>
      );
    case "ul":
      return (
        <View style={{ marginBottom: 8 }}>
          {node.items.map((item, index) => (
            <View key={index} style={{ flexDirection: "row", marginBottom: 2 }}>
              <Text style={{ color: colors.foreground, width: 16 }}>•</Text>
              <View style={{ flex: 1 }}>
                {item.blocks.map((child, childIndex) => (
                  <Block key={childIndex} node={child} colors={colors} />
                ))}
              </View>
            </View>
          ))}
        </View>
      );
    case "ol":
      return (
        <View style={{ marginBottom: 8 }}>
          {node.items.map((item, index) => (
            <View key={index} style={{ flexDirection: "row", marginBottom: 2 }}>
              <Text style={{ color: colors.foreground, width: 24 }}>{`${node.start + index}.`}</Text>
              <View style={{ flex: 1 }}>
                {item.blocks.map((child, childIndex) => (
                  <Block key={childIndex} node={child} colors={colors} />
                ))}
              </View>
            </View>
          ))}
        </View>
      );
    case "table":
      return (
        <View style={{ marginBottom: 8 }}>
          <TableRow cells={node.header} colors={colors} header />
          {node.rows.map((row, index) => (
            <TableRow key={index} cells={row} colors={colors} />
          ))}
        </View>
      );
    case "hr":
      return (
        <View
          style={{ height: 1, backgroundColor: CODE_BACKGROUND, marginVertical: 8 }}
        />
      );
  }
}

function TableRow({
  cells,
  colors,
  header,
}: {
  cells: InlineNode[][];
  colors: MarkdownColors;
  header?: boolean;
}) {
  return (
    <View style={{ flexDirection: "row" }}>
      {cells.map((cell, index) => (
        <View
          key={index}
          style={{
            flex: 1,
            borderWidth: 0.5,
            borderColor: CODE_BACKGROUND,
            padding: 4,
            backgroundColor: header ? CODE_BACKGROUND : "transparent",
          }}
        >
          <Text
            selectable
            style={{ color: colors.foreground, fontWeight: header ? "700" : "400" }}
          >
            <Inline nodes={cell} colors={colors} />
          </Text>
        </View>
      ))}
    </View>
  );
}

function Inline({ nodes, colors }: { nodes: InlineNode[]; colors: MarkdownColors }) {
  return (
    <>
      {nodes.map((node, index) => (
        <InlineNodeView key={index} node={node} colors={colors} />
      ))}
    </>
  );
}

function InlineNodeView({ node, colors }: { node: InlineNode; colors: MarkdownColors }) {
  switch (node.type) {
    case "text":
      return <Text>{node.text}</Text>;
    case "strong":
      return (
        <Text style={{ fontWeight: "700" }}>
          <Inline nodes={node.children} colors={colors} />
        </Text>
      );
    case "em":
      return (
        <Text style={{ fontStyle: "italic" }}>
          <Inline nodes={node.children} colors={colors} />
        </Text>
      );
    case "del":
      return (
        <Text style={{ textDecorationLine: "line-through" }}>
          <Inline nodes={node.children} colors={colors} />
        </Text>
      );
    case "code":
      return (
        <Text style={{ fontFamily: MONOSPACE, backgroundColor: CODE_BACKGROUND }}>{node.text}</Text>
      );
    case "link":
      return (
        <Text
          style={{ color: colors.accent }}
          onPress={() => {
            Linking.openURL(node.href).catch(() => undefined);
          }}
        >
          <Inline nodes={node.children} colors={colors} />
        </Text>
      );
    case "break":
      return <Text>{"\n"}</Text>;
  }
}
