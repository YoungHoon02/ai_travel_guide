import { useRef, useState, useCallback, useEffect, Suspense } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { RoundedBox, Html, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { motion } from "framer-motion";
import { softenContextLoss } from "../utils.js";

// ─── Single 3D card ──────────────────────────────────────────────────────────
function DestCard3DObj({ dest, index, col, row, isSelected, isHovered, onHover, onClick, hoverPoint }) {
  const ref = useRef();
  const x = col * 5.8;
  const y = -row * 4.4;

  useFrame(() => {
    if (!ref.current) return;
    const targetScale = isHovered ? 1.05 : 1;
    let targetRotX = 0;
    let targetRotY = 0;

    if (isHovered && hoverPoint) {
      const local = ref.current.worldToLocal(hoverPoint.clone());
      const nx = THREE.MathUtils.clamp(local.x / 2.3, -1, 1);
      const ny = THREE.MathUtils.clamp(local.y / 1.7, -1, 1);
      targetRotX = -ny * 0.15;
      targetRotY = nx * 0.15;
    }

    const targetZ = isHovered ? 0.3 : 0;
    ref.current.scale.setScalar(THREE.MathUtils.lerp(ref.current.scale.x, targetScale, 0.15));
    ref.current.rotation.y = THREE.MathUtils.lerp(ref.current.rotation.y, targetRotY, 0.2);
    ref.current.rotation.x = THREE.MathUtils.lerp(ref.current.rotation.x, targetRotX, 0.2);
    ref.current.position.z = THREE.MathUtils.lerp(ref.current.position.z, targetZ, 0.12);
  });

  const borderColor = isSelected ? "#e8a020" : isHovered ? "#5ecfcf" : "#2a2a2e";
  const city = dest.trav_loc_depth?.city ?? "";
  const country = dest.trav_loc_depth?.country ?? "";
  const photo = dest._photo;

  return (
    <group ref={ref} position={[x, y, 0]}>
      {/* Invisible hitbox for pointer events */}
      <RoundedBox
        args={[4.6, 3.4, 0.05]}
        radius={0.06}
        smoothness={4}
        onClick={(e) => { e.stopPropagation(); onClick(index); }}
        onPointerOver={(e) => { e.stopPropagation(); onHover(index, e.point); }}
        onPointerMove={(e) => { if (isHovered) onHover(index, e.point); }}
        onPointerOut={(e) => { e.stopPropagation(); onHover(-1, null); }}
      >
        <meshBasicMaterial transparent opacity={0} />
      </RoundedBox>

      {/* Selection glow */}
      {isSelected && <pointLight position={[0, 0, 0.6]} intensity={0.5} color="#e8a020" distance={2.5} />}

      {/* HTML overlay — photo bg + CSS border + header/footer glassmorphism */}
      <Html position={[0, 0, 0.03]} center transform distanceFactor={4.6} style={{ pointerEvents: "none" }} zIndexRange={[0, 0]} wrapperClass="dest-card-html-wrap">
        <div style={{
          width: "460px", height: "340px", pointerEvents: "none",
          borderRadius: "6px", overflow: "hidden",
          position: "relative", fontFamily: "inherit", userSelect: "none",
          backgroundImage: photo ? `url(${photo})` : "none",
          backgroundSize: "cover", backgroundPosition: "center",
          backgroundColor: "#0a0a0c",
          border: `2px solid ${isSelected ? "#e8a020" : isHovered ? "#5ecfcf" : "#2a2a2e"}`,
          boxShadow: isSelected ? "0 0 20px rgba(232,160,32,0.3)" : isHovered ? "0 0 15px rgba(94,207,207,0.2)" : "0 4px 20px rgba(0,0,0,0.5)",
          transition: "border-color 0.2s, box-shadow 0.3s",
        }}>
          {/* Gradient overlay */}
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.1) 35%, rgba(0,0,0,0.1) 65%, rgba(0,0,0,0.8) 100%)" }} />

          {/* HEADER — title + location in one row */}
          <div style={{
            position: "absolute", top: 0, left: 0, right: 0,
            background: "rgba(0,0,0,0.55)",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            padding: "12px 16px",
            display: "flex", alignItems: "center", gap: "12px",
          }}>
            <div style={{ fontSize: "24px", fontWeight: 800, color: "#fff", textTransform: "uppercase", letterSpacing: "0.05em", textShadow: "0 2px 12px rgba(0,0,0,0.9)", whiteSpace: "nowrap" }}>
              {dest.trav_loc}
            </div>
            <div style={{ fontSize: "18px", color: "rgba(255,255,255,0.7)", whiteSpace: "nowrap" }}>
              {country}{city ? ` · ${city}` : ""}
            </div>
          </div>

          {/* FOOTER — details */}
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            background: "rgba(0,0,0,0.55)",
            borderTop: "1px solid rgba(255,255,255,0.06)",
            padding: "10px 16px",
            display: "flex", flexDirection: "column", gap: "3px",
          }}>
            {dest.trav_loc_reason && (
              <div style={{ fontSize: "17px", color: "#5ecfcf", fontStyle: "italic" }}>
                {dest.trav_loc_reason}
              </div>
            )}
            <div style={{ fontSize: "18px", color: "rgba(255,255,255,0.85)", lineHeight: 1.5 }}>
              {dest.trav_loc_sum}
            </div>
          </div>

          {/* Selection badge */}
          {isSelected && <div style={{ position: "absolute", top: 10, right: 10, width: 26, height: 26, background: "#e8a020", color: "#0a0a0c", fontSize: 14, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 12px rgba(232,160,32,0.5)" }}>✓</div>}
        </div>
      </Html>
    </group>
  );
}

// ─── Scene ────────────────────────────────────────────────────────────────────
function AnimatedGroup({ targetX, targetY, children }) {
  const ref = useRef();
  useFrame(() => {
    if (!ref.current) return;
    ref.current.position.x = THREE.MathUtils.lerp(ref.current.position.x, targetX, 0.06);
    ref.current.position.y = THREE.MathUtils.lerp(ref.current.position.y, targetY, 0.06);
  });
  return <group ref={ref}>{children}</group>;
}

function AutoCamera({ cols, rows }) {
  const { camera, size } = useThree();
  const targetZ = useRef(10);

  useEffect(() => {
    const aspect = size.width / size.height;
    const gridW = cols * 5.8;
    const gridH = rows * 4.4;
    const fovRad = (50 * Math.PI / 180) / 2;
    const needW = gridW / (2 * Math.tan(fovRad) * aspect);
    const needH = gridH / (2 * Math.tan(fovRad));
    targetZ.current = Math.max(needW, needH) + 0.5;
  }, [cols, rows, size]);

  useFrame(() => {
    camera.position.z = THREE.MathUtils.lerp(camera.position.z, targetZ.current, 0.06);
  });

  return null;
}

function Scene({ destinations, selectedIdx, onSelect, page, maxPerPage, maxCols }) {
  const [hovered, setHovered] = useState(-1);
  const [hoverPt, setHoverPt] = useState(null);
  const visible = destinations.slice(page * maxPerPage, page * maxPerPage + maxPerPage);
  const cols = Math.min(maxCols ?? 4, visible.length);
  const rows = Math.ceil(visible.length / cols);

  return (
    <>
      <AutoCamera cols={cols} rows={rows} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 4, 8]} intensity={0.9} />
      {/* Side lights to illuminate card edges on tilt */}
      <pointLight position={[-8, 0, 3]} intensity={0.6} color="#5ecfcf" distance={20} />
      <pointLight position={[8, 0, 3]} intensity={0.6} color="#e8a020" distance={20} />
      <pointLight position={[0, -6, 3]} intensity={0.4} color="#ffffff" distance={15} />
      <pointLight position={[0, 6, 3]} intensity={0.4} color="#ffffff" distance={15} />
      <AnimatedGroup targetX={-(cols - 1) * 5.8 / 2} targetY={(rows - 1) * 4.4 / 2}>
        {visible.map((dest, idx) => {
          const globalIdx = page * maxPerPage + idx;
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          return (
            <DestCard3DObj
              key={globalIdx}
              dest={dest}
              index={globalIdx}
              col={col}
              row={row}
              isSelected={selectedIdx === globalIdx}
              isHovered={hovered === globalIdx}
              hoverPoint={hovered === globalIdx ? hoverPt : null}
              onHover={(idx, pt) => { setHovered(idx); setHoverPt(pt ?? null); }}
              onClick={onSelect}
            />
          );
        })}
      </AnimatedGroup>
      <OrbitControls enableZoom={false} enablePan={false} enableRotate={false} />
    </>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────
export default function DestCardGrid({ destinations, selectedIdx, onSelect, onProceed, onMore, moreLoading, page, maxPerPage, totalPages, onPageChange, maxCols }) {
  const handleClick = useCallback((globalIdx) => {
    onSelect(selectedIdx === globalIdx ? null : globalIdx);
  }, [selectedIdx, onSelect]);

  return (
    <div className="dest-grid-container">
      <div className="dest-grid__header">
        <span className="dest-grid__title">AI 추천 여행지 · {destinations.length}곳</span>
        {totalPages > 1 && (
          <div className="dest-grid__pager">
            <button disabled={page === 0} onClick={() => onPageChange(page - 1)}>←</button>
            <span>{page + 1} / {totalPages}</span>
            <button disabled={page >= totalPages - 1} onClick={() => onPageChange(page + 1)}>→</button>
          </div>
        )}
      </div>

      <div className="dest-grid__canvas">
        <Canvas camera={{ position: [0, 0, 8], fov: 50 }} onCreated={({ gl }) => softenContextLoss(gl)}>
          <Suspense fallback={null}>
            <Scene
              destinations={destinations}
              selectedIdx={selectedIdx}
              onSelect={handleClick}
              page={page}
              maxPerPage={maxPerPage}
              maxCols={maxCols}
            />
          </Suspense>
        </Canvas>
      </div>

      <div className="dest-grid__actions">
        {selectedIdx !== null && (
          <motion.button
            className="dest-grid__proceed"
            onClick={onProceed}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
          >
            {destinations[selectedIdx]?.trav_loc} 으로 진행 →
          </motion.button>
        )}
        <button className="dest-grid__more" disabled={moreLoading} onClick={onMore}>
          {moreLoading ? "추천 중…" : "+ 더 추천받기"}
        </button>
      </div>
    </div>
  );
}
