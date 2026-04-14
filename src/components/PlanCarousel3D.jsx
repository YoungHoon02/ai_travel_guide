import { useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { RoundedBox, Html } from "@react-three/drei";
import * as THREE from "three";

function PlanCard({ plan, index, total, hoveredIdx, onClick, isSelected }) {
  const ref = useRef();
  const baseX = (index - (total - 1) / 2) * 6.2;

  useFrame((state) => {
    if (!ref.current) return;
    const isHovered = hoveredIdx === index;
    const targetY = isHovered ? 0.1 : 0;
    const targetRotY = isHovered ? 0 : 0.25;
    const targetScale = isHovered ? 1.12 : 1;

    ref.current.position.y = THREE.MathUtils.lerp(ref.current.position.y, targetY, 0.08);
    ref.current.rotation.y = THREE.MathUtils.lerp(ref.current.rotation.y, targetRotY, 0.08);
    const s = THREE.MathUtils.lerp(ref.current.scale.x, targetScale, 0.08);
    ref.current.scale.setScalar(s);
    ref.current.position.y += Math.sin(state.clock.elapsedTime * 1.5 + index) * 0.005;
  });

  const color = isSelected ? "#3a2a10" : "#1e1e20";
  const edgeColor = isSelected ? "#e8a020" : "#3a3a3e";

  return (
    <group
      ref={ref}
      position={[baseX, 0, 0]}
      rotation={[0, 0.25, 0]}
      onClick={(e) => { e.stopPropagation(); onClick(plan.id); }}
    >
      <RoundedBox args={[5.6, 3.4, 0.08]} radius={0.05} smoothness={4}>
        <meshStandardMaterial color={color} roughness={0.4} metalness={0.4} />
      </RoundedBox>
      {/* Edge */}
      <RoundedBox args={[5.64, 3.44, 0.01]} radius={0.05} smoothness={4} position={[0, 0, 0.05]}>
        <meshStandardMaterial color={edgeColor} roughness={0.5} metalness={0.3} transparent opacity={0.5} />
      </RoundedBox>
      {/* Title only */}
      <Html position={[0, 0, 0.06]} center transform distanceFactor={4} style={{ pointerEvents: "none" }}>
        <div style={{
          width: "520px",
          textAlign: "center",
          fontFamily: "inherit",
          userSelect: "none",
        }}>
          <div style={{ fontSize: "32px", fontWeight: 700, color: isSelected ? "#e8a020" : "#e0e0e6", letterSpacing: "0.04em" }}>{plan.name}</div>
        </div>
      </Html>
      {isSelected && <pointLight position={[0, 0, 0.5]} intensity={0.5} color="#e8a020" distance={2} />}
    </group>
  );
}

function Scene({ plans, onSelect, selectedId }) {
  const [hovered, setHovered] = useState(-1);

  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[3, 4, 5]} intensity={0.7} />
      <pointLight position={[-3, 2, 3]} intensity={0.3} color="#5ecfcf" />
      <group
        onPointerMove={(e) => {
          if (!e.point) return;
          const idx = Math.round((e.point.x / 6.2) + (plans.length - 1) / 2);
          setHovered(Math.max(0, Math.min(plans.length - 1, idx)));
        }}
        onPointerLeave={() => setHovered(-1)}
      >
        {plans.map((plan, idx) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            index={idx}
            total={plans.length}
            hoveredIdx={hovered}
            isSelected={selectedId === plan.id}
            onClick={onSelect}
          />
        ))}
      </group>
    </>
  );
}

export default function PlanCarousel3D({ plans, selectedId, onSelect }) {
  if (!plans || plans.length === 0) return null;
  return (
    <div className="plan-carousel-3d">
      <Canvas camera={{ position: [0, 0.5, 10], fov: 55 }}>
        <Scene plans={plans} selectedId={selectedId} onSelect={onSelect} />
      </Canvas>
    </div>
  );
}
