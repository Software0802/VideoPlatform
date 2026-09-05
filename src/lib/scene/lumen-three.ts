import * as THREE from "three";

/*
  Genius — 两个纯 three.js 场景，移植自 design_handoff/design_handoff_genius_home/lumen-fx.js。
  每个 mount* 接收一个 <canvas>，自己管 renderer / rAF / 事件，返回带 dispose() 的句柄，
  由 SceneHost 在 useEffect 中挂载与卸载。
*/

export type SceneHandle = { dispose(): void };

const reduced = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

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

function fit(renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement, camera?: THREE.PerspectiveCamera): [number, number] {
  const w = canvas.clientWidth || 1;
  const h = canvas.clientHeight || 1;
  const size = renderer.getSize(new THREE.Vector2());
  if (size.x !== w || size.y !== h) {
    renderer.setSize(w, h, false);
    if (camera) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }
  return [w, h];
}

/* ── 1. 黎明河面：全屏 quad shader —— 暗天、暖色地平线、fbm 远山、透视水面、薄雾、暗角、颗粒 ── */
export type DawnHandle = SceneHandle & { setEnergy(v: number): void };

export function mountDawn(canvas: HTMLCanvasElement, opts: { horizon?: number } = {}): DawnHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;
  const uniforms = {
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uMouse: { value: new THREE.Vector2(0.5, 0.5) },
    uEnergy: { value: 0 },
    uHorizon: { value: opts.horizon ?? 0.46 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      precision highp float; varying vec2 vUv; uniform float uTime,uAspect,uEnergy,uHorizon; uniform vec2 uMouse;
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
      float fbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<4;i++){ v+=a*noise(p); p=p*2.02+vec2(3.1,1.7); a*=0.5; } return v; }
      const vec3 TOP=vec3(0.035,0.045,0.07), MID=vec3(0.10,0.11,0.16), WARM=vec3(0.62,0.40,0.30), FOG=vec3(0.15,0.16,0.20);
      // 天空 + 远山，按屏幕位置 p 采样（h 为地平线）
      vec3 sky(vec2 p, float h, float t){
        vec3 c=mix(MID,TOP,smoothstep(h,1.0,p.y));
        float n=fbm(vec2(p.x*uAspect*1.6+t*0.012, p.y*3.0-t*0.006));
        float band=exp(-pow((p.y-h)*(7.0-uEnergy*2.0),2.0));
        c+=WARM*band*(0.30+0.30*n+uEnergy*0.25);
        float far=fbm(vec2(p.x*uAspect*3.2+t*0.004,2.0));
        float ridgeY=h+0.01+far*0.06;
        c=mix(c*0.5,c,smoothstep(ridgeY-0.004,ridgeY+0.004,p.y));
        return c;
      }
      // 水面高度场（世界坐标：x 横向，y 为距离）
      float waves(vec2 p, float t){
        float w=0.0;
        w+=sin(p.y*1.7-t*0.9+sin(p.x*0.6+t*0.2)*1.1)*0.45;
        w+=sin((p.x*0.8+p.y*1.4)*1.7+t*1.25)*0.22;
        w+=sin((p.x*-1.3+p.y*0.9)*2.3-t*1.6)*0.12;
        w+=(fbm(p*0.9+vec2(t*0.22,-t*0.45))-0.5)*1.1;
        w+=(noise(p*3.6+vec2(-t*0.7,t*0.35))-0.5)*0.28;
        return w;
      }
      void main(){
        float t=uTime;
        vec2 par=(uMouse-0.5)*0.02;
        vec2 uv=vUv+par;
        float h=uHorizon+par.y*0.5;
        vec3 col=sky(uv,h,t);
        if(uv.y<h){
          float d=h-uv.y;
          // 透视：越近地平线距离越远
          float z=0.07/(d+0.012);
          vec2 wp=vec2((uv.x-0.5)*uAspect*z*1.5, z);
          float e=0.045*z;
          float hc=waves(wp,t), hx=waves(wp+vec2(e,0.0),t), hy=waves(wp+vec2(0.0,e),t);
          vec2 slope=vec2(hx-hc,hy-hc)/e;
          float lod=smoothstep(0.0,0.10,d);            // 贴近地平线抹平，防走样
          slope*=lod*(0.06+uEnergy*0.03);
          // 被表面法线扭曲的天空倒影
          vec2 rp=vec2(uv.x+slope.x*0.5, h+d*(1.0+slope.y*1.6)+abs(slope.x)*0.15);
          vec3 refl=sky(rp,h,t);
          float fres=mix(0.30,0.96,pow(1.0-smoothstep(0.0,0.7,d),1.6));
          vec3 deep=vec3(0.03,0.04,0.06);
          vec3 water=mix(deep,refl,fres);
          // 地平线光源在水面的碎光
          float lx=0.5+par.x*0.5;
          float g=1.0-abs(slope.y*3.0-0.10)*6.0-abs((uv.x-lx)*2.2+slope.x*1.5)*2.4;
          float glint=pow(clamp(g,0.0,1.0),5.0)*exp(-d*4.5)*(0.5+uEnergy*0.6)*lod;
          water+=WARM*glint;
          col=water;
        }
        float mist=smoothstep(h+0.05,h-0.22,uv.y)*smoothstep(h-0.45,h-0.18,uv.y)*(0.4+0.6*fbm(vec2(uv.x*uAspect*2.4+t*0.03,uv.y*6.0+t*0.01)));
        col=mix(col,FOG,mist*0.28);
        float vig=smoothstep(1.25,0.35,length((vUv-0.5)*vec2(1.15,1.0)));
        col*=0.75+0.25*vig;
        col+=(hash(vUv*vec2(1920.0,1080.0)+fract(t))-0.5)*0.02;
        gl_FragColor=vec4(col,1.0);
      }`,
  });
  const geo = new THREE.PlaneGeometry(2, 2);
  scene.add(new THREE.Mesh(geo, mat));

  const mouse = new THREE.Vector2(0.5, 0.5);
  const mouseT = new THREE.Vector2(0.5, 0.5);
  const onMove = (e: PointerEvent) => mouseT.set(e.clientX / window.innerWidth, 1 - e.clientY / window.innerHeight);
  window.addEventListener("pointermove", onMove);
  let energy = 0;
  let target = 0;
  let raf = 0;
  let disposed = false;
  const clock = makeClock();
  function frame() {
    if (disposed) return;
    const [w, h] = fit(renderer, canvas);
    uniforms.uAspect.value = w / h;
    if (!reduced()) uniforms.uTime.value = clock.getElapsedTime();
    energy += (target - energy) * 0.03;
    uniforms.uEnergy.value = energy;
    mouse.lerp(mouseT, 0.04);
    uniforms.uMouse.value.copy(mouse);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  frame();
  return {
    setEnergy(v) {
      target = v;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      geo.dispose();
      mat.dispose();
      renderer.dispose();
    },
  };
}

/* ── 2. 暗色作品环：真图挂成一圈，下方倒影；拖拽 / 自动慢转，hover 微放大，点击选中 ──
   平面按原色不透明渲染（贴图 sRGB 解码、不乘暗、不透底），保证成片颜色与文件一致；
   原型里的"未悬停 0.6 亮度"会把画面整体压暗并透出粉色地平线，按用户要求去掉。 */
export type RingHandle = SceneHandle & { setScroll(v: number): void; setAutoRotate(on: boolean): void };

type RingMesh = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

export function mountRingDark(
  canvas: HTMLCanvasElement,
  opts: {
    images: string[];
    radius?: number;
    /** 每秒 0.003 圈的自动慢转，默认开 */
    autoRotate?: boolean;
    onSelect?: (index: number) => void;
    onHover?: (index: number) => void;
    /** 环的当前角度（0–359），只在整数度变化时回调 */
    onTurn?: (deg: number) => void;
  },
): RingHandle {
  const R = opts.radius ?? 7.2;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 0, -R * 0.6);
  const loader = new THREE.TextureLoader();
  const geo = new THREE.PlaneGeometry(3.0, 1.6875);
  const planes: RingMesh[] = [];
  const reflections: RingMesh[] = [];
  const textures: THREE.Texture[] = [];
  let disposed = false;
  const n = Math.max(1, opts.images.length);
  opts.images.forEach((src, i) => {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const rm = new THREE.MeshBasicMaterial({ color: 0x9a9a9a, transparent: true, opacity: 0.12 });
    loader.load(src, (t) => {
      if (disposed) {
        t.dispose();
        return;
      }
      t.colorSpace = THREE.SRGBColorSpace;
      textures.push(t);
      mat.map = t;
      mat.needsUpdate = true;
      rm.map = t;
      rm.needsUpdate = true;
    });
    const m: RingMesh = new THREE.Mesh(geo, mat);
    m.userData = { i, a: (i / n) * Math.PI * 2, glow: 0 };
    const r: RingMesh = new THREE.Mesh(geo, rm);
    r.scale.y = -1;
    scene.add(m, r);
    planes.push(m);
    reflections.push(r);
  });

  let scroll = 0;
  let scrollT = 0;
  let auto = 0;
  let autoRotate = opts.autoRotate ?? true;
  let raf = 0;
  let hovered = -1;
  let lastDeg = -1;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2(9, 9);
  const tilt = new THREE.Vector2();
  const tiltT = new THREE.Vector2();
  const onMove = (e: PointerEvent) => {
    const b = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - b.left) / b.width) * 2 - 1, -(((e.clientY - b.top) / b.height) * 2 - 1));
    tiltT.set(ndc.x * 0.3, ndc.y * 0.2);
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
    fit(renderer, canvas, camera);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (autoRotate && !reduced()) auto += dt * 0.003;
    scroll += (scrollT - scroll) * 0.08;
    tilt.lerp(tiltT, 0.05);
    const turns = scroll + auto;
    const rot = turns * Math.PI * 2;
    for (let k = 0; k < planes.length; k++) {
      const m = planes[k];
      const a = (m.userData.a as number) + rot;
      m.position.set(Math.sin(a) * R, 0.15, Math.cos(a) * R);
      m.rotation.y = a + Math.PI;
      const r = reflections[k];
      r.position.set(Math.sin(a) * R, -1.75, Math.cos(a) * R);
      r.rotation.y = a + Math.PI;
    }
    camera.position.set(tilt.x * 0.8, tilt.y * 0.5, -R * 0.6);
    camera.lookAt(tilt.x * 0.4, 0.1, R);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(planes, false)[0];
    const next = hit ? (hit.object.userData.i as number) : -1;
    if (next !== hovered) {
      hovered = next;
      opts.onHover?.(hovered);
    }
    for (let k = 0; k < planes.length; k++) {
      const m = planes[k];
      const u = m.userData as { i: number; glow: number };
      u.glow += ((u.i === hovered ? 1 : 0) - u.glow) * 0.1;
      const s = 1 + u.glow * 0.04;
      m.scale.setScalar(s);
      reflections[k].scale.set(s, -s, s);
    }
    canvas.style.cursor = hovered >= 0 ? "pointer" : "grab";
    const deg = Math.round((((turns % 1) + 1) % 1) * 360) % 360;
    if (deg !== lastDeg) {
      lastDeg = deg;
      opts.onTurn?.(deg);
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  frame();
  return {
    setScroll(v) {
      scrollT = v;
    },
    setAutoRotate(on) {
      autoRotate = on;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      for (const m of planes) m.material.dispose();
      for (const r of reflections) r.material.dispose();
      for (const t of textures) t.dispose();
      geo.dispose();
      renderer.dispose();
    },
  };
}
