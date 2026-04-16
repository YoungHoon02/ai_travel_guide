import { useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { softenContextLoss } from "../utils.js";

/**
 * Night sky with occasional shooting stars. Most particles sit almost still
 * as distant background stars; a small fraction streak across as meteors.
 * Uses an exponentially-skewed velocity distribution so fast particles are
 * rare, giving an intermittent feel rather than a continuous snowfall.
 */
function PouringStars({ count = 450 }) {
  const ref = useRef();

  const { positions, colors, velocities } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const velocities = new Float32Array(count);
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 160;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 120;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 40;

      // Exponential skew — Math.pow(r, 5) heavily biases toward 0, so most
      // stars are nearly still (<0.5) and only a few shoot across quickly.
      const r = Math.random();
      velocities[i] = Math.pow(r, 5) * 22 + 0.08;

      // Shooting stars (high velocity) are whiter & brighter via color channel
      // — no per-vertex size is needed because PointsMaterial uses a uniform.
      const isShooter = velocities[i] > 5;
      const hue = 0.52 + Math.random() * 0.18;
      const sat = isShooter ? 0.35 : 0.75;
      const light = isShooter ? 0.95 : 0.5 + Math.random() * 0.3;
      color.setHSL(hue, sat, light);
      colors[i * 3]     = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    return { positions, colors, velocities };
  }, [count]);

  const tmpColor = useMemo(() => new THREE.Color(), []);

  useFrame((_, delta) => {
    if (!ref.current) return;
    const pos = ref.current.geometry.attributes.position.array;
    const col = ref.current.geometry.attributes.color.array;
    let colorDirty = false;
    for (let i = 0; i < count; i++) {
      // Rare spontaneous burst — a slow background star suddenly ignites
      // into meteor-shower speed, turns white, and shoots across.
      // Probability ~0.00003 per frame → ≈0.8 bursts/sec at 60fps with 450 stars.
      if (velocities[i] < 2 && Math.random() < 0.00003) {
        velocities[i] = 18 + Math.random() * 20;
        col[i * 3]     = 1;
        col[i * 3 + 1] = 1;
        col[i * 3 + 2] = 1;
        colorDirty = true;
      }

      pos[i * 3 + 1] -= velocities[i] * delta;
      pos[i * 3]     -= velocities[i] * delta * 0.3;

      if (pos[i * 3 + 1] < -70) {
        pos[i * 3 + 1] = 70 + Math.random() * 30;
        pos[i * 3]     = (Math.random() - 0.4) * 160;
        // Re-roll velocity using the same exponential skew so bursts are
        // genuinely rare even after reset.
        const r = Math.random();
        velocities[i] = Math.pow(r, 5) * 22 + 0.08;
        // Re-roll color to match new velocity class
        const isShooter = velocities[i] > 5;
        const hue = 0.52 + Math.random() * 0.18;
        const sat = isShooter ? 0.35 : 0.75;
        const light = isShooter ? 0.95 : 0.5 + Math.random() * 0.3;
        tmpColor.setHSL(hue, sat, light);
        col[i * 3]     = tmpColor.r;
        col[i * 3 + 1] = tmpColor.g;
        col[i * 3 + 2] = tmpColor.b;
        colorDirty = true;
      }
      if (pos[i * 3] < -90) {
        pos[i * 3] = 90;
      }
    }
    ref.current.geometry.attributes.position.needsUpdate = true;
    if (colorDirty) {
      ref.current.geometry.attributes.color.needsUpdate = true;
    }
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={positions} itemSize={3} />
        <bufferAttribute attach="attributes-color" count={count} array={colors} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial
        size={0.28}
        sizeAttenuation
        vertexColors
        transparent
        opacity={0.85}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

export default function StarfieldBackground({ className = "" }) {
  return (
    <div className={`starfield-bg ${className}`.trim()} aria-hidden="true">
      <Canvas
        camera={{ position: [0, 0, 40], fov: 70 }}
        gl={{ alpha: true, antialias: true }}
        dpr={[1, 2]}
        onCreated={({ gl }) => softenContextLoss(gl)}
      >
        <PouringStars />
      </Canvas>
    </div>
  );
}
