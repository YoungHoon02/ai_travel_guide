import { useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { RoundedBox, Html, OrbitControls } from "@react-three/drei";
import * as THREE from "three";

function PlanCard({ plan, index, total, onSelect, isSelected, hoveredIdx, onHover }) {
  const ref = useRef();
  const baseX = (index - (total - 1) / 2) * 3.5;
  const isHovered = hoveredIdx === index;

  useFrame(() => {
    if (!ref.current) return;
    const targetY = isHovered ? 0.2 : 0;
    const targetRotY = isHovered ? 0 : 0.3;
    const targetScale = isHovered ? 1.1 : 1;

    ref.current.position.y = THREE.MathUtils.lerp(ref.current.position.y, targetY, 0.08);
    ref.current.rotation.y = THREE.MathUtils.lerp(ref.current.rotation.y, targetRotY, 0.08);
    const s = THREE.MathUtils.lerp(ref.current.scale.x, targetScale, 0.08);
    ref.current.scale.setScalar(s);
  });

  const color = isSelected ? "#2a1a08" : "#1a1a1c";
  const edgeColor = isSelected ? "#e8a020" : "#3a3a3e";

  return (
    <group
      ref={ref}
      position={[baseX, 0, 0]}
      rotation={[0, 0.3, 0]}
      onClick={(e) => { e.stopPropagation(); onSelect(plan.id); }}
      onPointerOver={() => onHover(index)}
      onPointerOut={() => onHover(-1)}
    >
      <RoundedBox args={[2.8, 1.8, 0.08]} radius={0.04} smoothness={4}>
        <meshStandardMaterial color={color} roughness={0.3} metalness={0.5} />
      </RoundedBox>
      <RoundedBox args={[2.82, 1.82, 0.01]} radius={0.04} smoothness={4} position={[0, 0, 0.05]}>
        <meshStandardMaterial color={edgeColor} roughness={0.5} metalness={0.3} transparent opacity={0.5} />
      </RoundedBox>
      <Html position={[0, 0, 0.06]} center transform distanceFactor={3.5} style={{ pointerEvents: "none" }}>
        <div style={{ width: "240px", textAlign: "center", fontFamily: "inherit", userSelect: "none" }}>
          <div style={{ fontSize: "15px", fontWeight: 700, color: isSelected ? "#e8a020" : "#e0e0e6", letterSpacing: "0.04em", marginBottom: "4px" }}>{plan.name}</div>
          <div style={{ fontSize: "9px", color: "#8a8a94" }}>{plan.meta}</div>
          <div style={{ fontSize: "10px", color: "#6a6a72", marginTop: "4px" }}>{plan.detail}</div>
        </div>
      </Html>
      {isSelected && <pointLight position={[0, 0, 0.5]} intensity={0.5} color="#e8a020" distance={2} />}
      {isHovered && <pointLight position={[0, 0, 0.4]} intensity={0.3} color="#5ecfcf" distance={1.5} />}
    </group>
  );
}

function Scene({ plans, selectedId, onSelect }) {
  const [hovered, setHovered] = useState(-1);
  const groupRef = useRef();

  // Horizontal scroll via drag
  useFrame(() => {
    if (groupRef.current && plans.length > 3) {
      // gentle idle sway
    }
  });

  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[3, 4, 5]} intensity={0.7} />
      <pointLight position={[-3, 2, 3]} intensity={0.3} color="#5ecfcf" />
      <group ref={groupRef}>
        {plans.map((plan, idx) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            index={idx}
            total={plans.length}
            isSelected={selectedId === plan.id}
            onSelect={onSelect}
            hoveredIdx={hovered}
            onHover={setHovered}
          />
        ))}
      </group>
      <OrbitControls
        enableZoom={false}
        enablePan={true}
        enableRotate={false}
        panSpeed={2}
        screenSpacePanning={true}
      />
    </>
  );
}

export default function PlanCardRow({ plans, selectedId, onSelect }) {
  if (!plans || plans.length === 0) return null;
  return (
    <div className="plan-card-row-3d">
      <p className="plan-card-row__title">저장된 일정</p>
      <div className="plan-card-row-3d__canvas">
        <Canvas camera={{ position: [0, 0.3, 6], fov: 50 }}>
          <Scene plans={plans} selectedId={selectedId} onSelect={onSelect} />
        </Canvas>
      </div>
    </div>
  );
}
