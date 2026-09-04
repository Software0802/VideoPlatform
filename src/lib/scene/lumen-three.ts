import * as THREE from "three";
import type { SceneProgress } from "@/types/scene";

/*
  流光 · Lumen — 三个纯 three.js 场景，移植自 design_handoff/.../lumen-three.js。
  每个 mount* 接收一个 <canvas>，自己管 renderer / rAF / 事件，返回带 dispose() 的句柄，
  由 SceneHost 在 useEffect 中挂载与卸载。
*/

export type SceneHandle = { dispose(): void };

const reduced = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function makeRenderer(canvas: HTMLCanvasElement, alpha = true) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha, powerPreference: "high-performance" });
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  return r;
}

function fit(renderer: THREE.WebGLRenderer, camera: THREE.Camera, canvas: HTMLCanvasElement): [number, number] {
  const w = canvas.clientWidth || 1;
  const h = canvas.clientHeight || 1;
  const size = renderer.getSize(new THREE.Vector2());
  if (size.x !== w || size.y !== h) renderer.setSize(w, h, false);
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  return [w, h];
}


/** THREE.Clock 在 0.185 已弃用；这里用 performance.now 自己计时 */
function makeClock() {
  const start = performance.now() / 1000;
  let last = start;
  return {
    getDelta() {
      const n = performance.now() / 1000;
      const d = n - last;
      last = n;
      return d;
    },
    getElapsedTime() {
      return performance.now() / 1000 - start;
    },
  };
}

/* ── 1. 点阵：会呼吸、跟随指针的网点版 ── */
export type DotFieldHandle = SceneHandle & { setEnergy(v: number): void; setInk(c: string): void };

export function mountDotField(
  canvas: HTMLCanvasElement,
  opts: { ink?: string; cols?: number; rows?: number; base?: number } = {},
): DotFieldHandle {
  const ink = new THREE.Color(opts.ink ?? "#30343A");
  const cols = opts.cols ?? 110;
  const rows = opts.rows ?? 62;
  const renderer = makeRenderer(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 5;
  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  let i = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      pos[i * 3] = (x / (cols - 1)) * 2 - 1;
      pos[i * 3 + 1] = (y / (rows - 1)) * 2 - 1;
      pos[i * 3 + 2] = 0;
      uv[i * 2] = x / (cols - 1);
      uv[i * 2 + 1] = y / (rows - 1);
      i++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aUv", new THREE.BufferAttribute(uv, 2));
  const uniforms = {
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector2(9, 9) },
    uInk: { value: ink },
    uAspect: { value: 1 },
    uPx: { value: 1 },
    uEnergy: { value: 0 },
    uBase: { value: opts.base ?? 0.34 },
    uCell: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec2 aUv; uniform float uTime,uAspect,uPx,uEnergy,uBase,uCell; uniform vec2 uMouse; varying float vA;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      void main(){
        vec2 p=position.xy; p.x*=uAspect;
        float t=uTime*0.18;
        float w=sin(p.x*1.9+t*1.3+p.y*0.7)*0.5+0.5;
        float w2=sin(p.y*2.6-t*0.9+p.x*0.4)*0.5+0.5;
        float field=mix(w,w2,0.5);
        float d=distance(p,uMouse*vec2(uAspect,1.0));
        float m=smoothstep(0.75,0.0,d);
        float e=uEnergy;
        float blob=smoothstep(0.35,0.95,sin(p.x*0.9+t*0.7)*sin(p.y*1.3-t*0.5)*0.5+0.5);
        float r=uBase*(0.05+field*0.55+blob*0.9)+m*0.6+e*0.4*(0.5+0.5*sin(t*6.0+p.x*3.0));
        r*=0.55+0.45*hash(aUv);
        r*=smoothstep(0.15,1.05,length((p-vec2(-uAspect,-1.0))*vec2(0.8,1.3)));
        r*=smoothstep(0.05,0.5,length(p-vec2(-uAspect,1.0)));
        r*=smoothstep(0.05,0.55,length(p-vec2(uAspect,1.0)));
        vA=clamp(r,0.0,1.0);
        gl_PointSize=uCell*uPx*max(0.0,r*1.15);
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uInk; varying float vA;
      void main(){ vec2 c=gl_PointCoord-0.5; float d=length(c); float a=1.0-smoothstep(0.42,0.5,d); if(a<=0.0)discard; gl_FragColor=vec4(uInk,a*min(1.0,0.45+vA)); }`,
  });
  scene.add(new THREE.Points(geo, mat));
  let energy = 0;
  let target = 0;
  let raf = 0;
  let disposed = false;
  const mouse = new THREE.Vector2(9, 9);
  const mouseT = new THREE.Vector2(9, 9);
  const onMove = (e: PointerEvent) => {
    const b = canvas.getBoundingClientRect();
    mouseT.set(((e.clientX - b.left) / b.width) * 2 - 1, -(((e.clientY - b.top) / b.height) * 2 - 1));
  };
  const onLeave = () => mouseT.set(9, 9);
  window.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  const clock = makeClock();
  function frame() {
    if (disposed) return;
    const [w, h] = fit(renderer, camera, canvas);
    uniforms.uAspect.value = w / h;
    uniforms.uPx.value = renderer.getPixelRatio();
    uniforms.uCell.value = (w / cols) * 0.95;
    if (!reduced()) uniforms.uTime.value = clock.getElapsedTime();
    energy += (target - energy) * 0.04;
    uniforms.uEnergy.value = energy;
    mouse.lerp(mouseT, 0.08);
    uniforms.uMouse.value.copy(mouse);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  frame();
  return {
    setEnergy(v) {
      target = v;
    },
    setInk(c) {
      ink.set(c);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      renderer.dispose();
      geo.dispose();
      mat.dispose();
    },
  };
}

/* ── 2. 放映机线版：转速 = 进度，墨密度 = 状态 ── */
export type ReelHandle = SceneHandle & { setProgress(p: SceneProgress): void };

export function mountReel(
  canvas: HTMLCanvasElement,
  opts: { ink?: string; accent?: string; follow?: boolean; distance?: number; offsetX?: number } = {},
): ReelHandle {
  const renderer = makeRenderer(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(opts.offsetX ?? 0, 0, opts.distance ?? 4.4);
  const group = new THREE.Group();
  group.rotation.set(0.32, -0.3, 0);
  scene.add(group);

  // 单墨线版：每条边都是同一种墨的一笔
  const ink = new THREE.Color(opts.ink ?? "#2148B8");
  const accent = new THREE.Color(opts.accent ?? "#C65F38");
  const lm = new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.9 });
  const am = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.95 });
  const geos: THREE.BufferGeometry[] = [];
  const ring = (r: number, seg: number, mat: THREE.LineBasicMaterial) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    geos.push(g);
    return new THREE.Line(g, mat);
  };
  group.add(ring(1.42, 96, lm), ring(1.3, 96, lm), ring(0.6, 64, lm), ring(0.22, 32, am));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(Math.cos(a) * 0.24, Math.sin(a) * 0.24, 0),
      new THREE.Vector3(Math.cos(a) * 1.28, Math.sin(a) * 1.28, 0),
    ]);
    geos.push(g);
    group.add(new THREE.Line(g, lm));
  }
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(Math.cos(a) * 1.3, Math.sin(a) * 1.3, 0),
      new THREE.Vector3(Math.cos(a) * 1.42, Math.sin(a) * 1.42, 0),
    ]);
    geos.push(g);
    group.add(new THREE.Line(g, i % 12 === 0 ? am : lm));
  }
  // 一圈墨点 = 胶片穿孔，密度随进度上升
  const dn = 96;
  const dp = new Float32Array(dn * 3);
  for (let i = 0; i < dn; i++) {
    const a = (i / dn) * Math.PI * 2;
    dp[i * 3] = Math.cos(a) * 1.9;
    dp[i * 3 + 1] = Math.sin(a) * 1.9;
    dp[i * 3 + 2] = 0;
  }
  const dg = new THREE.BufferGeometry();
  dg.setAttribute("position", new THREE.BufferAttribute(dp, 3));
  geos.push(dg);
  const dotMat = new THREE.PointsMaterial({ size: 0.05, color: ink, transparent: true, opacity: 0.35, sizeAttenuation: true });
  group.add(new THREE.Points(dg, dotMat));

  const st = { speed: 0.1, glow: 0.3 };
  let progress: SceneProgress = { phase: "idle", progress: 0 };
  let raf = 0;
  let disposed = false;
  const clock = makeClock();
  const tilt = new THREE.Vector2();
  const tiltT = new THREE.Vector2();
  const onMove = (e: PointerEvent) => {
    tiltT.set((e.clientX / window.innerWidth - 0.5) * 0.5, (e.clientY / window.innerHeight - 0.5) * 0.5);
  };
  if (opts.follow) window.addEventListener("pointermove", onMove);

  function frame() {
    if (disposed) return;
    fit(renderer, camera, canvas);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.getElapsedTime();
    const r = reduced();
    const { phase, progress: p } = progress;
    const wantSpeed = r ? 0 : phase === "working" ? 0.35 + (p / 100) * 1.9 : phase === "done" ? 0.12 : phase === "error" ? 0.02 : 0.07;
    const wantGlow = phase === "done" ? 0.85 : phase === "working" ? 0.45 : 0.22;
    const k = Math.min(1, dt * 3.2);
    st.speed += (wantSpeed - st.speed) * k;
    st.glow += (wantGlow - st.glow) * k;
    group.rotation.z -= st.speed * dt;
    tilt.lerp(tiltT, 0.06);
    group.rotation.x = 0.32 + tilt.y;
    group.rotation.y = -0.3 + tilt.x;
    if (!r) group.position.y = Math.sin(t * 1.1) * 0.06;
    lm.opacity = 0.55 + st.glow * 0.5;
    dotMat.opacity = 0.15 + (phase === "working" ? p / 100 : phase === "done" ? 1 : 0) * 0.8;
    dotMat.size = 0.04 + (phase === "working" ? p / 100 : 0) * 0.06;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  frame();
  return {
    setProgress(p) {
      progress = p;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      for (const g of geos) g.dispose();
      lm.dispose();
      am.dispose();
      dotMat.dispose();
      renderer.dispose();
    },
  };
}

/* ── 3. 环形画廊：网点化的静帧挂在空间里，滚动 / 拖拽驱动旋转 ── */
export type WallHandle = SceneHandle & { setScroll(v: number): void };

export function mountWall(
  canvas: HTMLCanvasElement,
  opts: {
    images: string[];
    ink?: string;
    paper?: string;
    layout?: "ring" | "wall";
    cells?: number;
    radius?: number;
    onSelect?: (index: number) => void;
    onHover?: (index: number) => void;
  },
): WallHandle {
  const ink = new THREE.Color(opts.ink ?? "#2148B8");
  const paper = new THREE.Color(opts.paper ?? "#FAFAF7");
  const layout = opts.layout ?? "wall";
  const R = opts.radius ?? 7.2;
  const renderer = makeRenderer(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(0, 0, 9);
  const loader = new THREE.TextureLoader();
  const planes: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[] = [];
  const textures: THREE.Texture[] = [];
  const shader = {
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex; uniform vec3 uInk,uPaper; uniform float uCells,uHover,uAspect,uHas; varying vec2 vUv;
      void main(){
        vec3 c=texture2D(uTex,vUv).rgb; float lum=dot(c,vec3(0.299,0.587,0.114));
        lum=mix(0.72,lum,uHas);
        lum=pow(clamp((lum-0.04)*1.15,0.0,1.0),0.55);
        vec2 g=vUv*vec2(uCells*uAspect,uCells);
        vec2 cell=fract(g)-0.5;
        float r=(1.0-lum)*0.5;
        float d=length(cell);
        float dot_=1.0-smoothstep(r-0.06,r+0.02,d);
        float flat_=mix(0.0,1.0-lum,uHover);
        float k=max(dot_,flat_*0.9);
        gl_FragColor=vec4(mix(uPaper,uInk,k),1.0);
      }`,
  };
  const geo = new THREE.PlaneGeometry(3.0, 1.6875);
  const edgeGeo = new THREE.EdgesGeometry(geo);
  const edgeMat = new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.55 });
  const blank = new THREE.DataTexture(new Uint8Array([245, 241, 232, 255]), 1, 1);
  blank.needsUpdate = true;
  const images = opts.images;
  images.forEach((src, i) => {
    const mat = new THREE.ShaderMaterial({
      ...shader,
      uniforms: {
        uTex: { value: blank },
        uInk: { value: ink },
        uPaper: { value: paper },
        uCells: { value: opts.cells ?? 62 },
        uHover: { value: 0 },
        uAspect: { value: 16 / 9 },
        uHas: { value: 0 },
      },
    });
    loader.load(src, (t) => {
      if (disposed) {
        t.dispose();
        return;
      }
      t.colorSpace = THREE.SRGBColorSpace;
      textures.push(t);
      mat.uniforms.uTex.value = t;
      mat.uniforms.uHas.value = 1;
    });
    const m = new THREE.Mesh(geo, mat);
    m.userData.i = i;
    // 细线框 = 1px 内嵌规则
    m.add(new THREE.LineSegments(edgeGeo, edgeMat));
    if (layout === "ring") {
      const a = (i / images.length) * Math.PI * 2;
      m.position.set(Math.sin(a) * R, 0, Math.cos(a) * R);
      m.rotation.y = a + Math.PI;
      m.userData.a = a;
    } else {
      const col = i % 3;
      const row = Math.floor(i / 3);
      m.position.set((col - 1) * 3.5, -row * 2.15, (col === 1 ? 0.4 : 0) + ((i * 7) % 3) * -0.3);
      m.userData.base = m.position.clone();
    }
    scene.add(m);
    planes.push(m);
  });
  const rows = Math.ceil(images.length / 3);
  let scroll = 0;
  let scrollT = 0;
  let raf = 0;
  let disposed = false;
  let hovered = -1;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2(9, 9);
  const tilt = new THREE.Vector2();
  const tiltT = new THREE.Vector2();
  const onMove = (e: PointerEvent) => {
    const b = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - b.left) / b.width) * 2 - 1, -(((e.clientY - b.top) / b.height) * 2 - 1));
    tiltT.set(ndc.x * 0.35, ndc.y * 0.25);
  };
  const onLeave = () => {
    ndc.set(9, 9);
    tiltT.set(0, 0);
  };
  // 区分拖拽与点击：位移超过 6px 视为拖拽，不触发选中
  let downX = 0;
  let downY = 0;
  const onDown = (e: PointerEvent) => {
    downX = e.clientX;
    downY = e.clientY;
  };
  const onUp = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
    if (hovered >= 0) opts.onSelect?.(hovered);
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  const clock = makeClock();
  function frame() {
    if (disposed) return;
    fit(renderer, camera, canvas);
    const t = clock.getElapsedTime();
    scroll += (scrollT - scroll) * 0.08;
    tilt.lerp(tiltT, 0.06);
    if (layout === "ring") {
      const rot = scroll * Math.PI * 2 + (reduced() ? 0 : t * 0.03);
      for (const m of planes) {
        const a = (m.userData.a as number) + rot;
        m.position.set(Math.sin(a) * R, 0, Math.cos(a) * R);
        m.rotation.y = a + Math.PI;
      }
      camera.position.set(tilt.x * 1.2, tilt.y * 0.8, 0);
      camera.lookAt(0, 0, R);
    } else {
      const travel = Math.max(0, rows - 1) * 2.15;
      camera.position.set(tilt.x * 0.9, -scroll * travel + tilt.y * 0.6, 9.4);
      camera.rotation.set(tilt.y * 0.08, -tilt.x * 0.1, 0);
      planes.forEach((m, i) => {
        const b = m.userData.base as THREE.Vector3;
        m.position.z = b.z + (reduced() ? 0 : Math.sin(t * 0.6 + i) * 0.05);
      });
    }
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(planes, false)[0];
    const next = hit ? (hit.object.userData.i as number) : -1;
    if (next !== hovered) {
      hovered = next;
      opts.onHover?.(hovered);
    }
    for (const m of planes) {
      const u = m.material.uniforms.uHover;
      u.value += ((m.userData.i === hovered ? 1 : 0) - u.value) * 0.12;
    }
    canvas.style.cursor = hovered >= 0 ? "pointer" : "grab";
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  frame();
  return {
    setScroll(v) {
      scrollT = v;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      for (const m of planes) m.material.dispose();
      for (const t of textures) t.dispose();
      blank.dispose();
      edgeMat.dispose();
      edgeGeo.dispose();
      geo.dispose();
      renderer.dispose();
    },
  };
}
