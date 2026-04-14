import { useRef, useState, useCallback, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Sphere, Line, useTexture, Stars } from "@react-three/drei";
import * as THREE from "three";
import { callGenericLLM } from "../api.js";
import { GLOBE_GEOGRAPHY_PROMPT } from "../prompts/index.js";

// ─── Coordinate conversions ──────────────────────────────────────────────────
function latLngToVec3(lat, lng, radius = 1.01) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

function vec3ToLatLng(vec) {
  const radius = vec.length();
  const lat = 90 - Math.acos(vec.y / radius) * (180 / Math.PI);
  const lng = Math.atan2(vec.z, -vec.x) * (180 / Math.PI) - 180;
  return [lat, ((lng + 540) % 360) - 180];
}

function formatCoords(lat, lng) {
  const latDir = lat >= 0 ? "N" : "S";
  const lngDir = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)}°${latDir} ${Math.abs(lng).toFixed(4)}°${lngDir}`;
}

// ─── Earth ───────────────────────────────────────────────────────────────────
function Earth({ spinning, onClickGlobe, speedMultiplier = 1 }) {
  const ref = useRef();
  const speed = useRef(0.05);
  const stopped = useRef(false);
  const pointerDownPos = useRef(null);

  const earthTexture = useTexture("https://unpkg.com/three-globe@2.41.12/example/img/earth-day.jpg");

  useFrame(() => {
    if (!ref.current) return;
    if (spinning && !stopped.current) ref.current.rotation.y += speed.current;
  });

  useEffect(() => {
    if (spinning) {
      speed.current = (0.04 + Math.random() * 0.02) * speedMultiplier;
      stopped.current = false;
    }
  }, [spinning]);

  return (
    <group ref={ref}>
      <Sphere args={[1, 64, 64]}
        onPointerDown={(e) => { pointerDownPos.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={(e) => {
          if (!onClickGlobe || !pointerDownPos.current) return;
          const dx = e.clientX - pointerDownPos.current.x;
          const dy = e.clientY - pointerDownPos.current.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          pointerDownPos.current = null;
          if (dist > 5) return;
          e.stopPropagation();
          stopped.current = true;
          ref.current.updateMatrixWorld(true);
          const dartPos = e.point.clone().normalize().multiplyScalar(1.02);
          // Undo globe rotation to get original sphere-space coordinates
          const invQuat = ref.current.quaternion.clone().invert();
          const localPoint = e.point.clone().normalize().applyQuaternion(invQuat);
          const latlng = vec3ToLatLng(localPoint);
          onClickGlobe(dartPos, latlng);
        }}
      >
        <meshStandardMaterial map={earthTexture} roughness={0.7} metalness={0.05} />
      </Sphere>
      <Sphere args={[1.02, 32, 32]}>
        <meshBasicMaterial color="#4488aa" transparent opacity={0.08} side={THREE.BackSide} />
      </Sphere>
      <GridLines />
    </group>
  );
}

function GridLines() {
  const lines = [];
  const eqPoints = [];
  for (let i = 0; i <= 64; i++) {
    const angle = (i / 64) * Math.PI * 2;
    eqPoints.push(new THREE.Vector3(Math.cos(angle) * 1.005, 0, Math.sin(angle) * 1.005));
  }
  lines.push(<Line key="eq" points={eqPoints} color="#3a8888" lineWidth={0.5} transparent opacity={0.3} />);
  for (let m = 0; m < 12; m++) {
    const mPoints = [];
    for (let i = 0; i <= 32; i++) mPoints.push(latLngToVec3(-90 + (i / 32) * 180, (m / 12) * 360, 1.005));
    lines.push(<Line key={`m${m}`} points={mPoints} color="#3a8888" lineWidth={0.3} transparent opacity={0.15} />);
  }
  return <>{lines}</>;
}

// ─── Dart ─────────────────────────────────────────────────────────────────────
function Dart({ target, throwing, visible, onLanded }) {
  const ref = useRef();
  const progress = useRef(0);
  const startPos = useRef(new THREE.Vector3(3, 2, 3));
  const landed = useRef(false);

  useEffect(() => {
    if (!visible) { landed.current = false; }
    if (throwing && target) { progress.current = 0; landed.current = false; startPos.current = new THREE.Vector3(2.5 + Math.random(), 1.5 + Math.random(), 2.5 + Math.random()); }
  }, [throwing, target, visible]);

  useFrame((_, delta) => {
    if (!ref.current || !throwing || !target || landed.current) return;
    progress.current = Math.min(1, progress.current + delta * 0.8);
    const t = progress.current;
    const ease = t < 0.7 ? t * t * 0.5 : 0.245 + (t - 0.7) * 2.517;
    const pos = new THREE.Vector3().lerpVectors(startPos.current, target, Math.min(1, ease));
    pos.y += Math.sin(t * Math.PI) * 0.3 * (1 - t);
    ref.current.position.copy(pos);
    // Always point toward globe center (0,0,0) so dart tip faces inward
    ref.current.lookAt(0, 0, 0);
    if (t >= 1 && !landed.current) { landed.current = true; ref.current.position.copy(target); ref.current.lookAt(0, 0, 0); onLanded(); }
  });

  if (!visible || (!throwing && !landed.current)) return null;
  return (
    <group ref={ref}>
      {/* Dart rotated so tip points forward (negative Z) */}
      <group rotation={[Math.PI / 2, 0, 0]}>
        {/* Tail (feathers) — away from globe */}
        <mesh position={[0, 0.08, 0]}>
          <coneGeometry args={[0.025, 0.06, 6]} />
          <meshStandardMaterial color="#e8a020" emissive="#e8a020" emissiveIntensity={0.3} />
        </mesh>
        {/* Body */}
        <mesh>
          <cylinderGeometry args={[0.008, 0.008, 0.1, 8]} />
          <meshStandardMaterial color="#cccccc" />
        </mesh>
        {/* Tip (needle) — into globe */}
        <mesh position={[0, -0.08, 0]}>
          <coneGeometry args={[0.006, 0.05, 4]} />
          <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.3} />
        </mesh>
      </group>
    </group>
  );
}

// ─── Landing pin ─────────────────────────────────────────────────────────────
function LandingPin({ position }) {
  const ref = useRef();
  useFrame((state) => { if (ref.current) ref.current.scale.setScalar(1 + Math.sin(state.clock.elapsedTime * 3) * 0.1); });
  if (!position) return null;
  return (
    <group position={position} ref={ref}>
      <mesh><sphereGeometry args={[0.03, 16, 16]} /><meshStandardMaterial color="#e8a020" emissive="#e8a020" emissiveIntensity={0.8} /></mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}><ringGeometry args={[0.04, 0.06, 32]} /><meshBasicMaterial color="#e8a020" transparent opacity={0.4} side={THREE.DoubleSide} /></mesh>
    </group>
  );
}

// ─── Camera controller — reset on retry, focus on dart after landing ─────────
function CameraController({ phase, landedPos, flagMode }) {
  const { camera } = useThree();
  const controlsRef = useRef();
  const focusTimer = useRef(null);

  // Reset camera to default on spinning (retry)
  useEffect(() => {
    if (phase === "spinning" || phase === "idle") {
      camera.position.set(0, 0.8, 2.6);
      camera.lookAt(0, 0, 0);
      if (controlsRef.current) {
        controlsRef.current.target.set(0, 0, 0);
        controlsRef.current.update();
      }
    }
  }, [phase, camera]);

  // After dart lands, wait 2 sec then smoothly rotate to face the pin
  useEffect(() => {
    if (phase !== "landed" || !landedPos) return;
    if (focusTimer.current) clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => {
      // Calculate camera position to look at the pin from outside
      const pinDir = new THREE.Vector3(landedPos.x, landedPos.y, landedPos.z).normalize();
      const camPos = pinDir.clone().multiplyScalar(2.8);
      // Smooth move
      const start = camera.position.clone();
      const duration = 1200;
      const startTime = Date.now();
      function animate() {
        const t = Math.min(1, (Date.now() - startTime) / duration);
        const ease = t * (2 - t); // ease-out
        camera.position.lerpVectors(start, camPos, ease);
        camera.lookAt(0, 0, 0);
        if (controlsRef.current) controlsRef.current.update();
        if (t < 1) requestAnimationFrame(animate);
      }
      animate();
    }, 2000);
    return () => { if (focusTimer.current) clearTimeout(focusTimer.current); };
  }, [phase, landedPos, camera]);

  return (
    <OrbitControls
      ref={controlsRef}
      enableZoom={flagMode}
      enablePan={false}
      autoRotate={phase === "idle" && !flagMode}
      autoRotateSpeed={0.5}
    />
  );
}

// ─── Scene ────────────────────────────────────────────────────────────────────
function Scene({ phase, onClickGlobe, dartTarget, onDartLanded, landedPos, speedMultiplier, flagMode }) {
  return (
    <>
      <color attach="background" args={["#000008"]} />
      <Stars radius={100} depth={50} count={3000} factor={4} fade speed={1} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[5, 3, 5]} intensity={1.0} />
      <pointLight position={[-3, -2, 4]} intensity={0.3} color="#5ecfcf" />
      <Earth spinning={phase === "spinning" && !flagMode} onClickGlobe={(phase === "spinning" || flagMode) ? onClickGlobe : undefined} speedMultiplier={speedMultiplier} />
      <Dart target={dartTarget} throwing={phase === "throwing"} visible={phase === "throwing" || phase === "landed"} onLanded={onDartLanded} />
      <CameraController phase={phase} landedPos={landedPos} flagMode={flagMode} />
    </>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────
export default function GlobeDart({ onResult, onClose, active, onLog }) {
  const [phase, setPhase] = useState("idle"); // idle → spinning → throwing → landed
  const [dartTarget, setDartTarget] = useState(null);
  const [landedPos, setLandedPos] = useState(null);
  const [resultLatLng, setResultLatLng] = useState(null);
  const [locationLabel, setLocationLabel] = useState(null);
  const [resolvedName, setResolvedName] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [spinSpeed, setSpinSpeed] = useState(0.2);
  const [flagMode, setFlagMode] = useState(false);

  const handleStart = useCallback(() => {
    if (phase !== "idle" && phase !== "landed") return;
    setLandedPos(null);
    setResultLatLng(null);
    setDartTarget(null);
    setLocationLabel(null);
    setPhase("spinning");
  }, [phase]);

  const handleClickGlobe = useCallback((worldPoint, latlng) => {
    if (phase !== "spinning" && !flagMode) return;
    setDartTarget(worldPoint);
    setResultLatLng(latlng);
    setPhase("throwing");
  }, [phase, flagMode]);

  const handleDartLanded = useCallback(() => {
    setLandedPos(dartTarget);
    setPhase("landed");
  }, [dartTarget]);

  // Confirm — send to parent for LLM processing
  const handleConfirm = useCallback(() => {
    if (resultLatLng && onResult) onResult(resultLatLng, resolvedName);
  }, [resultLatLng, onResult, resolvedName]);

  const handleRetry = useCallback(() => {
    setLandedPos(null);
    setDartTarget(null);
    setResultLatLng(null);
    setLocationLabel(null);
    setResolvedName(null);
    setPhase("spinning");
  }, []);

  useEffect(() => {
    if (active && phase === "idle" && !flagMode) handleStart();
  }, [active, phase, handleStart, flagMode]);

  // Decode location when landed — Google Maps → LLM fallback
  useEffect(() => {
    if (phase !== "landed" || !resultLatLng) return;
    setResolving(true);
    setLocationLabel(null);
    setResolvedName(null);

    async function decode() {
      let label = null;

      // Try Google Maps reverse geocode first
      if (window.google?.maps?.Geocoder) {
        label = await new Promise((resolve) => {
          new window.google.maps.Geocoder().geocode(
            { location: { lat: resultLatLng[0], lng: resultLatLng[1] } },
            (results, status) => {
              if (status === "OK" && results?.[0]) {
                const components = results[0].address_components;
                const country = components?.find(c => c.types.includes("country"))?.long_name ?? "";
                const city = components?.find(c => c.types.includes("locality") || c.types.includes("administrative_area_level_1"))?.long_name ?? "";
                const name = `${city}, ${country}`.replace(/^, /, "");
                resolve(name || null);
              } else {
                resolve(null);
              }
            }
          );
        });
      }

      // LLM decode — always run for richer label.
      // LLM result's `label` is our canonical clean name (no emoji prefix) that
      // the parent can use to fill the hero input. Falls back to Geocoder label,
      // then coords (never a Plus Code like "76833J3P+GV").
      let clean = null;
      try {
        const result = await callGenericLLM(
          GLOBE_GEOGRAPHY_PROMPT,
          `좌표: ${formatCoords(resultLatLng[0], resultLatLng[1])}${label ? `, 위치: ${label}` : ""}`,
          onLog ?? (() => {}),
          "geography"
        );
        if (result?.label) {
          clean = result.label;
          setLocationLabel(`${result.emoji ?? "📍"} ${result.label}`);
        } else if (label) {
          clean = label;
          setLocationLabel(`📍 ${label}`);
        } else {
          setLocationLabel(`📍 ${formatCoords(resultLatLng[0], resultLatLng[1])}`);
        }
      } catch {
        if (label) {
          clean = label;
          setLocationLabel(`📍 ${label}`);
        } else {
          setLocationLabel(`📍 ${formatCoords(resultLatLng[0], resultLatLng[1])}`);
        }
      }
      setResolvedName(clean);
      setResolving(false);
    }

    decode();
  }, [phase, resultLatLng]);

  return (
    <div className="globe-dart">
      <Canvas camera={{ fov: 45 }}>
        <Scene phase={phase} onClickGlobe={handleClickGlobe} dartTarget={dartTarget} onDartLanded={handleDartLanded} landedPos={landedPos} speedMultiplier={spinSpeed} flagMode={flagMode} />
      </Canvas>

      {/* Bottom toolbar */}
      <div className="globe-dart__toolbar">
        <div className="globe-dart__speed">
          <label>SPEED</label>
          <input type="range" min="0.2" max="3" step="0.1" value={spinSpeed} onChange={(e) => setSpinSpeed(parseFloat(e.target.value))} />
          <span>{spinSpeed.toFixed(1)}x</span>
        </div>
        <div className="globe-dart__info">
          {phase === "idle" && !flagMode && <span className="globe-dart__hint">🌍 클릭하여 시작</span>}
          {phase === "idle" && flagMode && <span className="globe-dart__hint">🚩 지구본을 돌려서 깃발을 꽂으세요</span>}
          {phase === "spinning" && (
            <div className="globe-dart__hint-stack">
              <span className="globe-dart__hint globe-dart__hint--spin">🎯 지구본을 클릭하여 다트를 던지세요!</span>
              <span className="globe-dart__hint-sub">혹은 직접 깃발을 꽂으세요 🚩</span>
            </div>
          )}
          {phase === "throwing" && <span className="globe-dart__hint">다트 투척 중…</span>}
          {phase === "landed" && (
            <div className="globe-dart__landed-info">
              <span className="globe-dart__coords">{resultLatLng ? formatCoords(resultLatLng[0], resultLatLng[1]) : ""}</span>
              {resolving ? <span className="globe-dart__resolving">위치 확인 중…</span> : locationLabel && <span className="globe-dart__location">{locationLabel}</span>}
            </div>
          )}
        </div>
        <div className="globe-dart__actions">
          <button type="button" className={`globe-dart__flag-btn ${flagMode ? "active" : ""}`} onClick={() => { setFlagMode((v) => !v); if (!flagMode) setPhase("idle"); }} title="깃발 모드 — 직접 위치 선택">
            🚩
          </button>
          {phase === "landed" && (
            <>
              <button type="button" className="globe-dart__retry" onClick={() => { handleRetry(); if (flagMode) setPhase("idle"); }}>다시</button>
              <button type="button" className="globe-dart__confirm" onClick={handleConfirm}>결정</button>
            </>
          )}
          <div className="globe-dart__spacer" />
          {onClose && <button type="button" className="globe-dart__close" onClick={onClose}>✕</button>}
        </div>
      </div>
    </div>
  );
}
