import { useMemo, useCallback } from "react";
import ReactFlow, { Background, Controls, Handle, Position, useReactFlow, ReactFlowProvider } from "reactflow";
import "reactflow/dist/style.css";
import { prepare, layout } from "@chenglou/pretext";

// ─── Pretext height measurement ──────────────────────────────────────────────
const NODE_FONT = '12px "JetBrains Mono", "Fira Code", "SF Mono", monospace';
const NODE_WIDTH = 460; // max content width inside node
const LINE_HEIGHT = 18;
const NODE_PAD = 40; // vertical padding + label + gaps

function measureTextHeight(text, maxWidth = NODE_WIDTH) {
  if (!text) return 0;
  try {
    const prepared = prepare(text, NODE_FONT);
    const result = layout(prepared, maxWidth, LINE_HEIGHT);
    return result.height;
  } catch {
    // Fallback: estimate based on char count
    const charsPerLine = Math.floor(maxWidth / 8);
    const lines = Math.ceil(text.length / charsPerLine);
    return lines * LINE_HEIGHT;
  }
}

function measureNodeHeight(type, data) {
  let h = NODE_PAD;
  if (type === "user") {
    h += measureTextHeight(data.label, NODE_WIDTH);
  } else if (type === "ai") {
    // Each destination: name + reason + summary
    for (const d of (data.destinations ?? [])) {
      h += measureTextHeight(d.trav_loc, NODE_WIDTH) + 8;
      if (d.trav_loc_reason) h += measureTextHeight(d.trav_loc_reason, NODE_WIDTH);
      h += 24; // padding between dests
    }
    // Follow-up chips
    if (data.followUps?.length > 0) {
      h += 30 + data.followUps.length * 16;
    }
  } else if (type === "refresh") {
    h += (data.followUps?.length ?? 0) * 24 + 10;
  } else if (type === "start") {
    h = 50;
  }
  return Math.max(h, 50);
}

// ─── Custom node types ───────────────────────────────────────────────────────

function UserNode({ data }) {
  return (
    <div className="flow-node flow-node--user">
      <Handle type="target" position={Position.Top} className="flow-handle" />
      <div className="flow-node__label">USER</div>
      <div className="flow-node__text">{data.label}</div>
      <Handle type="source" position={Position.Bottom} className="flow-handle" />
    </div>
  );
}

function AiNode({ data }) {
  return (
    <div className="flow-node flow-node--ai">
      <Handle type="target" position={Position.Top} className="flow-handle" />
      <div className="flow-node__label">AI RESPONSE</div>
      <div className="flow-node__destinations">
        {(data.destinations ?? []).map((d, i) => (
          <div key={i} className="flow-node__dest">
            <strong>{d.trav_loc}</strong>
            {d.trav_loc_reason && <span className="flow-node__reason">{d.trav_loc_reason}</span>}
          </div>
        ))}
      </div>
      {data.followUps && data.followUps.length > 0 && (
        <div className="flow-node__followups">
          {data.followUps.map((q, i) => (
            <span key={i} className="flow-node__followup-chip">{q}</span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="flow-handle" />
    </div>
  );
}

function StartNode({ data }) {
  return (
    <div className="flow-node flow-node--start">
      <div className="flow-node__text">{data.label}</div>
      <Handle type="source" position={Position.Bottom} className="flow-handle" />
    </div>
  );
}

function RefreshNode({ data }) {
  return (
    <div className="flow-node flow-node--refresh">
      <Handle type="target" position={Position.Top} className="flow-handle" />
      <div className="flow-node__label">REFRESH #{data.index ?? 1}</div>
      <div className="flow-node__followups">
        {(data.followUps ?? []).map((q, i) => (
          <span key={i} className="flow-node__followup-chip">{q}</span>
        ))}
      </div>
      <Handle type="source" position={Position.Bottom} className="flow-handle" />
    </div>
  );
}

function LuckyNode({ data }) {
  return (
    <div className="flow-node flow-node--lucky">
      <Handle type="target" position={Position.Top} className="flow-handle" />
      <div className="flow-node__label">🎲 RANDOM</div>
      <div className="flow-node__text">{data.label}</div>
      <Handle type="source" position={Position.Bottom} className="flow-handle" />
    </div>
  );
}

const nodeTypes = { user: UserNode, ai: AiNode, start: StartNode, refresh: RefreshNode, lucky: LuckyNode };

// ─── Build nodes & edges from chat history ───────────────────────────────────

function buildFlow(chatHistory, currentSuggestions, currentFollowUps) {
  const nodes = [];
  const edges = [];
  let y = 0;
  const X = 0;
  const Y_PAD = 30; // gap between nodes

  // Start node
  nodes.push({
    id: "start",
    type: "start",
    position: { x: X, y },
    data: { label: "CHOOSE YOUR DESTINY" },
    style: { width: "auto" },
  });
  y += measureNodeHeight("start", { label: "CHOOSE YOUR DESTINY" }) + Y_PAD;

  let prevId = "start";
  let pairIdx = 0;
  let refreshCount = 0;
  let lastRefreshContent = null;

  for (let i = 0; i < chatHistory.length; i += 2) {
    const userMsg = chatHistory[i];
    const aiMsg = chatHistory[i + 1];
    if (!userMsg) break;

    const isRefresh = userMsg._type === "refresh";
    const isLucky = userMsg._type === "lucky";

    if (isLucky) {
      const luckyId = `lucky-${pairIdx}`;
      let theme = "";
      try { theme = JSON.parse(aiMsg?.content ?? "{}").theme ?? ""; } catch {}
      nodes.push({ id: luckyId, type: "lucky", position: { x: X, y }, data: { label: theme || userMsg.content }, style: { width: "auto" } });
      edges.push({ id: `e-${prevId}-${luckyId}`, source: prevId, target: luckyId, animated: true, style: { stroke: "#e8a020", strokeWidth: 2, strokeDasharray: "8 4" } });
      y += measureNodeHeight("user", { label: theme }) + Y_PAD;
      prevId = luckyId;
      pairIdx++;
      continue;
    }

    if (isRefresh) {
      const refreshId = `refresh-${pairIdx}`;
      let followUps = [];
      try { const parsed = JSON.parse(aiMsg?.content ?? "{}"); followUps = parsed.follow_up_questions ?? []; } catch {}

      // Check if content changed — reset counter if new questions
      const contentKey = JSON.stringify(followUps);
      if (contentKey !== lastRefreshContent) {
        refreshCount++;
        lastRefreshContent = contentKey;
      }

      nodes.push({
        id: refreshId,
        type: "refresh",
        position: { x: X, y },
        data: { followUps, index: refreshCount },
        style: { width: "auto" },
      });
      edges.push({
        id: `e-${prevId}-${refreshId}`,
        source: prevId,
        target: refreshId,
        animated: true,
        style: { stroke: "#8a8a94", strokeWidth: 1, strokeDasharray: "5 3" },
      });
      y += measureNodeHeight("refresh", { followUps }) + Y_PAD;
      prevId = refreshId;
      pairIdx++;
      continue;
    }
    // Reset refresh counter on non-refresh node
    refreshCount = 0;
    lastRefreshContent = null;

    const userId = `user-${pairIdx}`;
    const userLabel = userMsg.content;

    nodes.push({
      id: userId,
      type: "user",
      position: { x: X, y },
      data: { label: userLabel },
      style: { width: "auto" },
    });
    edges.push({
      id: `e-${prevId}-${userId}`,
      source: prevId,
      target: userId,
      animated: true,
      style: { stroke: "#5ecfcf", strokeWidth: 2 },
    });
    y += measureNodeHeight("user", { label: userLabel }) + Y_PAD;
    prevId = userId;

    if (aiMsg) {
      const aiId = `ai-${pairIdx}`;
      let destinations = [];
      let followUps = [];
      try {
        const parsed = JSON.parse(aiMsg.content);
        destinations = parsed.destinations ?? (Array.isArray(parsed) ? parsed : []);
        followUps = parsed.follow_up_questions ?? [];
      } catch {}

      nodes.push({
        id: aiId,
        type: "ai",
        position: { x: X, y },
        data: { destinations, followUps },
        style: { width: "auto" },
      });
      edges.push({
        id: `e-${prevId}-${aiId}`,
        source: prevId,
        target: aiId,
        animated: true,
        style: { stroke: "#e8a020", strokeWidth: 2 },
      });
      y += measureNodeHeight("ai", { destinations, followUps }) + Y_PAD;
      prevId = aiId;
    }
    pairIdx++;
  }

  // Show current results if not yet in history
  if (currentSuggestions.length > 0 && chatHistory.length === 0) {
    const aiId = "ai-current";
    nodes.push({
      id: aiId,
      type: "ai",
      position: { x: X, y },
      data: { destinations: currentSuggestions, followUps: currentFollowUps },
      style: { width: "auto" },
    });
    edges.push({
      id: `e-${prevId}-${aiId}`,
      source: prevId,
      target: aiId,
      animated: true,
      style: { stroke: "#e8a020", strokeWidth: 2 },
    });
  }

  return { nodes, edges };
}

// ─── Inner component (needs ReactFlowProvider) ───────────────────────────────

function FlowInner({ chatHistory, suggestions, followUps }) {
  const { fitView } = useReactFlow();

  const { nodes, edges } = useMemo(
    () => buildFlow(chatHistory, suggestions, followUps),
    [chatHistory, suggestions, followUps]
  );

  // Auto-fit when nodes change
  const onInit = useCallback(() => {
    setTimeout(() => fitView({ padding: 0.3, duration: 300 }), 100);
  }, [fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onInit={onInit}
      fitView
      fitViewOptions={{ padding: 0.3 }}
      proOptions={{ hideAttribution: true }}
      panOnDrag
      zoomOnScroll
      minZoom={0.3}
      maxZoom={1.5}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
    >
      <Background color="#2c2c30" gap={20} size={1} />
      <Controls showInteractive={false} className="flow-controls" />
    </ReactFlow>
  );
}

// ─── Exported component ──────────────────────────────────────────────────────

export default function DestFlowDiagram({ chatHistory, suggestions, followUps }) {
  const hasContent = chatHistory.length > 0 || suggestions.length > 0;
  if (!hasContent) return null;

  return (
    <div className="dest-flow">
      <ReactFlowProvider>
        <FlowInner chatHistory={chatHistory} suggestions={suggestions} followUps={followUps} />
      </ReactFlowProvider>
    </div>
  );
}
