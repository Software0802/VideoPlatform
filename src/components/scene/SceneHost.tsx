"use client";

import { useMemo, useRef } from "react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Float } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProgress } from "@/types/scene";

const AMBER = "#d3ac72";
const AMBER_HOT = "#e6c48c";
const STEEL = "#8ea6c4";
const DANGER = "#e08a63";

/** 放映机卷轴：轮缘 + 辐条 + 轮毂，转速与光色即任务状态 */
function Reel({ progress }: { progress: SceneProgress }) {
  const group = useRef<THREE.Group>(null);
  const keyLight = useRef<THREE.PointLight>(null);
  const rimMat = useRef<THREE.MeshStandardMaterial>(null);
  const beamMat = useRef<THREE.MeshBasicMaterial>(null);
  const state = useRef({ speed: 0.1, glow: 0.3, light: 1.1 });
  const reduced = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const spokes = useMemo(() => new Array(5).fill(0).map((_, i) => (i / 5) * Math.PI * 2), []);
  const dust = useMemo(() => {
    // 固定种子的 PRNG：尘埃场在每次渲染间保持稳定（渲染期必须纯函数）
    let seed = 0x9e3779b9;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const count = 240;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (rand() - 0.5) * 9;
      pos[i * 3 + 1] = (rand() - 0.5) * 6;
      pos[i * 3 + 2] = (rand() - 0.5) * 4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return geo;
  }, []);
  const dustRef = useRef<THREE.Points>(null);

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    const { phase, progress: p } = progress;
    const target = state.current;
    const wantSpeed = reduced
      ? 0
      : phase === "working"
        ? 0.35 + (p / 100) * 1.9
        : phase === "done"
          ? 0.12
          : phase === "error"
            ? 0.02
            : 0.07;
    const wantGlow = phase === "done" ? 0.85 : phase === "working" ? 0.45 : 0.22;
    const wantLight = phase === "working" ? 1.9 : phase === "done" ? 2.4 : phase === "error" ? 0.7 : 1.1;
    const k = Math.min(1, delta * 3.2);
    target.speed += (wantSpeed - target.speed) * k;
    target.glow += (wantGlow - target.glow) * k;
    target.light += (wantLight - target.light) * k;

    if (group.current) group.current.rotation.z -= target.speed * delta;
    if (rimMat.current) {
      rimMat.current.emissiveIntensity =
        target.glow + (phase === "done" && !reduced ? Math.sin(t * 2.2) * 0.12 : 0);
      const c = phase === "error" ? DANGER : phase === "done" ? AMBER_HOT : AMBER;
      rimMat.current.emissive.set(c);
      rimMat.current.color.set(phase === "error" ? "#8a5a44" : "#c9ad7f");
    }
    if (keyLight.current) {
      keyLight.current.intensity = target.light;
      keyLight.current.color.set(phase === "error" ? DANGER : "#ffd9a8");
    }
    if (beamMat.current) {
      beamMat.current.opacity =
        (phase === "working" ? 0.1 : phase === "done" ? 0.14 : 0.05) *
        (reduced ? 0.6 : 1);
    }
    if (dustRef.current && !reduced) {
      dustRef.current.rotation.y = t * 0.018;
      dustRef.current.position.y = Math.sin(t * 0.24) * 0.12;
    }
  });

  return (
    <>
      <pointLight ref={keyLight} position={[2.6, 2.2, 3]} intensity={1.1} color="#ffd9a8" />
      {/* 放映光束 */}
      <mesh position={[2.4, 1.9, 0.4]} rotation={[0.35, 0, -0.72]}>
        <coneGeometry args={[1.7, 5.2, 32, 1, true]} />
        <meshBasicMaterial
          ref={beamMat}
          color={AMBER_HOT}
          transparent
          opacity={0.05}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* 光束里的尘埃 */}
      <points ref={dustRef} geometry={dust}>
        <pointsMaterial
          size={0.022}
          color="#e8d9b8"
          transparent
          opacity={0.42}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          sizeAttenuation
        />
      </points>

      <Float speed={reduced ? 0 : 1.1} rotationIntensity={0.22} floatIntensity={0.35}>
        <group ref={group} rotation={[0.32, -0.3, 0]}>
          {/* 轮缘 */}
          <mesh>
            <torusGeometry args={[1.32, 0.1, 22, 72]} />
            <meshStandardMaterial
              ref={rimMat}
              color="#c9ad7f"
              emissive={AMBER}
              emissiveIntensity={0.22}
              metalness={0.85}
              roughness={0.28}
            />
          </mesh>
          {/* 内环 */}
          <mesh>
            <torusGeometry args={[0.58, 0.045, 16, 48]} />
            <meshStandardMaterial color="#8f7c5c" metalness={0.8} roughness={0.35} />
          </mesh>
          {/* 辐条 */}
          {spokes.map((a) => (
            <mesh key={a} rotation={[0, 0, a]}>
              <boxGeometry args={[0.075, 1.24, 0.06]} />
              <meshStandardMaterial color="#b89a6c" metalness={0.82} roughness={0.32} />
            </mesh>
          ))}
          {/* 轮毂 */}
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.2, 0.2, 0.2, 28]} />
            <meshStandardMaterial color="#ece6d9" metalness={0.5} roughness={0.35} />
          </mesh>
        </group>
      </Float>

      {/* 地面反射光斑 */}
      <mesh position={[0, -2.1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[2.6, 48]} />
        <meshBasicMaterial
          color={AMBER}
          transparent
          opacity={0.05}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </>
  );
}

export function SceneHost({ progress }: { progress: SceneProgress }) {
  return (
    <div className="relative h-full min-h-[300px] w-full bg-bg" data-scene-host aria-hidden="true">
      <SceneErrorBoundary>
        <Canvas
          camera={{ position: [0, 0, 4.4], fov: 42 }}
          gl={{ antialias: true, alpha: true }}
          dpr={[1, 2]}
        >
          <ambientLight intensity={0.3} />
          <directionalLight position={[3, 4, 2]} intensity={0.9} color="#ffe6c2" />
          <pointLight position={[-2.4, -1.2, 2]} intensity={0.5} color={STEEL} />
          <Reel progress={progress} />
        </Canvas>
      </SceneErrorBoundary>
    </div>
  );
}

type SceneErrorBoundaryProps = { children: ReactNode };
type SceneErrorBoundaryState = { failed: boolean };

/** WebGL is an enhancement; a failed context must never remove the HTML form. */
class SceneErrorBoundary extends Component<
  SceneErrorBoundaryProps,
  SceneErrorBoundaryState
> {
  state: SceneErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): SceneErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the failure diagnosable without exposing it in the UI.
    console.warn("Lumen scene disabled; using the static dark-field fallback", error, info);
  }

  render() {
    if (this.state.failed) {
      return <div className="scene-fallback" aria-hidden="true" />;
    }
    return this.props.children;
  }
}
