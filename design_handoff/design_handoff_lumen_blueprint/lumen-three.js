import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function makeRenderer(canvas, alpha = true) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha, powerPreference: 'high-performance' });
  r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  return r;
}
function fit(renderer, camera, canvas) {
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  renderer.setSize(w, h, false);
  if (camera.isPerspectiveCamera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  return [w, h];
}

/* ── 1. Halftone dot field — a screened plate that breathes and follows the pointer ── */
export function mountDotField(canvas, opts = {}) {
  const ink = new THREE.Color(opts.ink || '#30343A');
  const cols = opts.cols || 110, rows = opts.rows || 62;
  const renderer = makeRenderer(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 5;
  const n = cols * rows;
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let i = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    pos[i * 3] = (x / (cols - 1)) * 2 - 1; pos[i * 3 + 1] = (y / (rows - 1)) * 2 - 1; pos[i * 3 + 2] = 0;
    uv[i * 2] = x / (cols - 1); uv[i * 2 + 1] = y / (rows - 1); i++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
  const uniforms = {
    uTime: { value: 0 }, uMouse: { value: new THREE.Vector2(9, 9) }, uInk: { value: ink },
    uAspect: { value: 1 }, uPx: { value: 1 }, uEnergy: { value: 0 }, uBase: { value: opts.base ?? 0.34 },
    uCell: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    vertexShader: `
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
        // paper knock-outs: the headline corner and the masthead corners stay exposed
        r*=smoothstep(0.15,1.05,length((p-vec2(-uAspect,-1.0))*vec2(0.8,1.3)));
        r*=smoothstep(0.05,0.5,length(p-vec2(-uAspect,1.0)));
        r*=smoothstep(0.05,0.55,length(p-vec2(uAspect,1.0)));
        vA=clamp(r,0.0,1.0);
        gl_PointSize=uCell*uPx*max(0.0,r*1.15);
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
      }`,
    fragmentShader: `
      uniform vec3 uInk; varying float vA;
      void main(){ vec2 c=gl_PointCoord-0.5; float d=length(c); float a=1.0-smoothstep(0.42,0.5,d); if(a<=0.0)discard; gl_FragColor=vec4(uInk,a*min(1.0,0.45+vA)); }`,
  });
  scene.add(new THREE.Points(geo, mat));
  let energy = 0, target = 0, raf = 0, disposed = false;
  const mouse = new THREE.Vector2(9, 9), mouseT = new THREE.Vector2(9, 9);
  const onMove = (e) => {
    const b = canvas.getBoundingClientRect();
    mouseT.set(((e.clientX - b.left) / b.width) * 2 - 1, -(((e.clientY - b.top) / b.height) * 2 - 1));
  };
  const onLeave = () => mouseT.set(9, 9);
  window.addEventListener('pointermove', onMove); canvas.addEventListener('pointerleave', onLeave);
  const clock = new THREE.Clock();
  function frame() {
    if (disposed) return;
    const [w, h] = fit(renderer, camera, canvas);
    uniforms.uAspect.value = w / h; uniforms.uPx.value = renderer.getPixelRatio();
    uniforms.uCell.value = (w / cols) * 0.95;
    if (!reduced()) uniforms.uTime.value = clock.getElapsedTime();
    energy += (target - energy) * 0.04; uniforms.uEnergy.value = energy;
    mouse.lerp(mouseT, 0.08); uniforms.uMouse.value.copy(mouse);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  frame();
  return {
    setEnergy(v) { target = v; },
    setInk(c) { ink.set(c); },
    dispose() { disposed = true; cancelAnimationFrame(raf); window.removeEventListener('pointermove', onMove); renderer.dispose(); geo.dispose(); mat.dispose(); },
  };
}

/* ── 2. Reel — projector reel; speed = progress, colour = status ── */
export function mountReel(canvas, opts = {}) {
  const style = opts.style || 'amber'; // 'amber' (baseline) | 'ink' (line plate)
  const renderer = makeRenderer(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(opts.offsetX ?? 0, 0, opts.distance ?? 4.4);
  const group = new THREE.Group(); group.rotation.set(0.32, -0.3, 0); scene.add(group);
  let rimMat, keyLight, beamMat, dust;
  if (style === 'amber') {
    const AMBER = '#d3ac72', AMBER_HOT = '#e6c48c', DANGER = '#e08a63';
    scene.add(new THREE.AmbientLight(0xffffff, 0.3));
    const dl = new THREE.DirectionalLight('#ffe6c2', 0.9); dl.position.set(3, 4, 2); scene.add(dl);
    const pl = new THREE.PointLight('#8ea6c4', 0.5); pl.position.set(-2.4, -1.2, 2); scene.add(pl);
    keyLight = new THREE.PointLight('#ffd9a8', 1.1); keyLight.position.set(2.6, 2.2, 3); scene.add(keyLight);
    beamMat = new THREE.MeshBasicMaterial({ color: AMBER_HOT, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
    const beam = new THREE.Mesh(new THREE.ConeGeometry(1.7, 5.2, 32, 1, true), beamMat); beam.position.set(2.4, 1.9, 0.4); beam.rotation.set(0.35, 0, -0.72); scene.add(beam);
    let seed = 0x9e3779b9; const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const dp = new Float32Array(240 * 3); for (let i = 0; i < 240; i++) { dp[i * 3] = (rand() - .5) * 9; dp[i * 3 + 1] = (rand() - .5) * 6; dp[i * 3 + 2] = (rand() - .5) * 4; }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
    dust = new THREE.Points(dg, new THREE.PointsMaterial({ size: 0.022, color: '#e8d9b8', transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true })); scene.add(dust);
    rimMat = new THREE.MeshStandardMaterial({ color: '#c9ad7f', emissive: AMBER, emissiveIntensity: 0.22, metalness: 0.85, roughness: 0.28 });
    group.add(new THREE.Mesh(new THREE.TorusGeometry(1.32, 0.1, 22, 72), rimMat));
    group.add(new THREE.Mesh(new THREE.TorusGeometry(0.58, 0.045, 16, 48), new THREE.MeshStandardMaterial({ color: '#8f7c5c', metalness: 0.8, roughness: 0.35 })));
    for (let i = 0; i < 5; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.075, 1.24, 0.06), new THREE.MeshStandardMaterial({ color: '#b89a6c', metalness: 0.82, roughness: 0.32 })); s.rotation.z = (i / 5) * Math.PI * 2; group.add(s); }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.2, 28), new THREE.MeshStandardMaterial({ color: '#ece6d9', metalness: 0.5, roughness: 0.35 })); hub.rotation.x = Math.PI / 2; group.add(hub);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(2.6, 48), new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false })); floor.position.y = -2.1; floor.rotation.x = -Math.PI / 2; scene.add(floor);
    rimMat.__colors = { AMBER, AMBER_HOT, DANGER };
  } else {
    // one-ink line plate: every edge is a stroke of the same ink
    const ink = new THREE.Color(opts.ink || '#2148B8');
    const accent = new THREE.Color(opts.accent || '#C65F38');
    const lm = new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.9 });
    const am = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.95 });
    const ring = (r, seg, mat) => { const pts = []; for (let i = 0; i <= seg; i++) { const a = (i / seg) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0)); } return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat); };
    group.add(ring(1.42, 96, lm), ring(1.3, 96, lm), ring(0.6, 64, lm), ring(0.22, 32, am));
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(Math.cos(a) * .24, Math.sin(a) * .24, 0), new THREE.Vector3(Math.cos(a) * 1.28, Math.sin(a) * 1.28, 0)]); group.add(new THREE.Line(g, lm)); }
    for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(Math.cos(a) * 1.3, Math.sin(a) * 1.3, 0), new THREE.Vector3(Math.cos(a) * 1.42, Math.sin(a) * 1.42, 0)]); group.add(new THREE.Line(g, i % 12 === 0 ? am : lm)); }
    // ring of ink dots = film perforations, density rises with progress
    const dn = 96, dp = new Float32Array(dn * 3); for (let i = 0; i < dn; i++) { const a = (i / dn) * Math.PI * 2; dp[i * 3] = Math.cos(a) * 1.9; dp[i * 3 + 1] = Math.sin(a) * 1.9; dp[i * 3 + 2] = 0; }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
    dust = new THREE.Points(dg, new THREE.PointsMaterial({ size: 0.05, color: ink, transparent: true, opacity: 0.35, sizeAttenuation: true })); group.add(dust);
    rimMat = { ink: lm, accent: am, dots: dust.material, colors: { ink, accent } };
  }
  const st = { speed: 0.1, glow: 0.3, light: 1.1 };
  let progress = { phase: 'idle', progress: 0 }, raf = 0, disposed = false;
  const clock = new THREE.Clock();
  const tilt = new THREE.Vector2(), tiltT = new THREE.Vector2();
  const onMove = (e) => { tiltT.set((e.clientX / innerWidth - .5) * .5, (e.clientY / innerHeight - .5) * .5); };
  if (opts.follow) window.addEventListener('pointermove', onMove);
  function frame() {
    if (disposed) return;
    fit(renderer, camera, canvas);
    const dt = Math.min(clock.getDelta(), 0.05), t = clock.getElapsedTime(), r = reduced();
    const { phase, progress: p } = progress;
    const wantSpeed = r ? 0 : phase === 'working' ? 0.35 + (p / 100) * 1.9 : phase === 'done' ? 0.12 : phase === 'error' ? 0.02 : 0.07;
    const wantGlow = phase === 'done' ? 0.85 : phase === 'working' ? 0.45 : 0.22;
    const wantLight = phase === 'working' ? 1.9 : phase === 'done' ? 2.4 : phase === 'error' ? 0.7 : 1.1;
    const k = Math.min(1, dt * 3.2);
    st.speed += (wantSpeed - st.speed) * k; st.glow += (wantGlow - st.glow) * k; st.light += (wantLight - st.light) * k;
    group.rotation.z -= st.speed * dt;
    tilt.lerp(tiltT, 0.06); group.rotation.x = 0.32 + tilt.y; group.rotation.y = -0.3 + tilt.x;
    if (!r) group.position.y = Math.sin(t * 1.1) * 0.06;
    if (style === 'amber') {
      const C = rimMat.__colors;
      rimMat.emissiveIntensity = st.glow + (phase === 'done' && !r ? Math.sin(t * 2.2) * 0.12 : 0);
      rimMat.emissive.set(phase === 'error' ? C.DANGER : phase === 'done' ? C.AMBER_HOT : C.AMBER);
      rimMat.color.set(phase === 'error' ? '#8a5a44' : '#c9ad7f');
      keyLight.intensity = st.light; keyLight.color.set(phase === 'error' ? C.DANGER : '#ffd9a8');
      beamMat.opacity = (phase === 'working' ? 0.1 : phase === 'done' ? 0.14 : 0.05) * (r ? 0.6 : 1);
      if (!r) { dust.rotation.y = t * 0.018; dust.position.y = Math.sin(t * 0.24) * 0.12; }
    } else {
      const g = st.glow;
      rimMat.ink.opacity = 0.55 + g * 0.5; rimMat.dots.opacity = 0.15 + (phase === 'working' ? p / 100 : phase === 'done' ? 1 : 0) * 0.8;
      rimMat.dots.size = 0.04 + (phase === 'working' ? p / 100 : 0) * 0.06;
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  frame();
  return {
    setProgress(p) { progress = p; },
    dispose() { disposed = true; cancelAnimationFrame(raf); window.removeEventListener('pointermove', onMove); renderer.dispose(); },
  };
}

/* ── 3. Wall — screened stills hung in space; scroll drives the camera ── */
export function mountWall(canvas, opts = {}) {
  const ink = new THREE.Color(opts.ink || '#2148B8'), paper = new THREE.Color(opts.paper || '#FAFAF7');
  const layout = opts.layout || 'wall';
  const renderer = makeRenderer(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(0, 0, 9);
  const loader = new THREE.TextureLoader();
  const planes = [];
  const shader = {
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      uniform sampler2D uTex; uniform vec3 uInk,uPaper; uniform float uCells,uHover,uAspect; varying vec2 vUv;
      void main(){
        vec3 c=texture2D(uTex,vUv).rgb; float lum=dot(c,vec3(0.299,0.587,0.114));
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
  const images = opts.images || [];
  images.forEach((src, i) => {
    const mat = new THREE.ShaderMaterial({ ...shader, uniforms: { uTex: { value: null }, uInk: { value: ink }, uPaper: { value: paper }, uCells: { value: opts.cells || 62 }, uHover: { value: 0 }, uAspect: { value: 16 / 9 } } });
    loader.load(src, (t) => { t.colorSpace = THREE.SRGBColorSpace; mat.uniforms.uTex.value = t; });
    const m = new THREE.Mesh(geo, mat); m.userData.i = i;
    // hairline frame = 1px inset rule
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.55 })); m.add(edge);
    if (layout === 'ring') {
      const a = (i / images.length) * Math.PI * 2; const R = 7.2;
      m.position.set(Math.sin(a) * R, 0, Math.cos(a) * R); m.rotation.y = a + Math.PI;
      m.userData.a = a;
    } else {
      const col = i % 3, row = Math.floor(i / 3);
      m.position.set((col - 1) * 3.5, -row * 2.15, (col === 1 ? 0.4 : 0) + ((i * 7) % 3) * -0.3);
      m.userData.base = m.position.clone();
    }
    scene.add(m); planes.push(m);
  });
  const rows = Math.ceil(images.length / 3);
  let scroll = 0, scrollT = 0, raf = 0, disposed = false, hovered = -1;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(9, 9), tilt = new THREE.Vector2(), tiltT = new THREE.Vector2();
  const onMove = (e) => {
    const b = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - b.left) / b.width) * 2 - 1, -(((e.clientY - b.top) / b.height) * 2 - 1));
    tiltT.set(ndc.x * 0.35, ndc.y * 0.25);
  };
  const onLeave = () => { ndc.set(9, 9); tiltT.set(0, 0); };
  canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerleave', onLeave);
  const onClick = () => { if (hovered >= 0 && opts.onSelect) opts.onSelect(hovered); };
  canvas.addEventListener('click', onClick);
  const clock = new THREE.Clock();
  function frame() {
    if (disposed) return;
    fit(renderer, camera, canvas);
    const t = clock.getElapsedTime();
    scroll += (scrollT - scroll) * 0.08; tilt.lerp(tiltT, 0.06);
    if (layout === 'ring') {
      const rot = scroll * Math.PI * 2 + (reduced() ? 0 : t * 0.03);
      planes.forEach((m) => { const a = m.userData.a + rot; m.position.set(Math.sin(a) * 7.2, 0, Math.cos(a) * 7.2); m.rotation.y = a + Math.PI; });
      camera.position.set(tilt.x * 1.2, tilt.y * 0.8, 0); camera.lookAt(0, 0, 7.2);
    } else {
      const travel = Math.max(0, rows - 1) * 2.15;
      camera.position.set(tilt.x * 0.9, -scroll * travel + tilt.y * 0.6, 9.4);
      camera.rotation.set(tilt.y * 0.08, -tilt.x * 0.1, 0);
      planes.forEach((m, i) => { const b = m.userData.base; m.position.z = b.z + (reduced() ? 0 : Math.sin(t * 0.6 + i) * 0.05); });
    }
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(planes, false)[0];
    hovered = hit ? hit.object.userData.i : -1;
    planes.forEach((m) => { const u = m.material.uniforms.uHover; u.value += ((m.userData.i === hovered ? 1 : 0) - u.value) * 0.12; });
    canvas.style.cursor = hovered >= 0 ? 'pointer' : 'default';
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  frame();
  return {
    setScroll(v) { scrollT = v; },
    dispose() { disposed = true; cancelAnimationFrame(raf); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('click', onClick); renderer.dispose(); geo.dispose(); },
  };
}
