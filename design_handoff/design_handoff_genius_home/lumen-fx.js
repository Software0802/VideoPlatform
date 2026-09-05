import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
export { mountDotField, mountWall } from './lumen-three.js';

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Dawn mist — a dark sky, a warm horizon band and slow fog. Energy brightens the horizon. */
export function mountDawn(canvas, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); camera.position.z = 1;
  const uniforms = { uTime: { value: 0 }, uAspect: { value: 1 }, uMouse: { value: new THREE.Vector2(0.5, 0.5) }, uEnergy: { value: 0 }, uHorizon: { value: opts.horizon ?? 0.46 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position,1.0); }`,
    fragmentShader: `
      precision highp float; varying vec2 vUv; uniform float uTime,uAspect,uEnergy,uHorizon; uniform vec2 uMouse;
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
      float fbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<4;i++){ v+=a*noise(p); p=p*2.02+vec2(3.1,1.7); a*=0.5; } return v; }
      const vec3 TOP=vec3(0.035,0.045,0.07), MID=vec3(0.10,0.11,0.16), WARM=vec3(0.62,0.40,0.30), FOG=vec3(0.15,0.16,0.20);
      // sky + far ridge, sampled at screen position p (y above horizon h)
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
      // water height field in world space (x across, y = distance)
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
          // perspective: distance grows toward the horizon
          float z=0.07/(d+0.012);
          vec2 wp=vec2((uv.x-0.5)*uAspect*z*1.5, z);
          float e=0.045*z;
          float hc=waves(wp,t), hx=waves(wp+vec2(e,0.0),t), hy=waves(wp+vec2(0.0,e),t);
          vec2 slope=vec2(hx-hc,hy-hc)/e;
          float lod=smoothstep(0.0,0.10,d);            // flatten right at the horizon (anti-alias)
          slope*=lod*(0.06+uEnergy*0.03);
          // reflected sky, displaced by the surface normal
          vec2 rp=vec2(uv.x+slope.x*0.5, h+d*(1.0+slope.y*1.6)+abs(slope.x)*0.15);
          vec3 refl=sky(rp,h,t);
          float fres=mix(0.30,0.96,pow(1.0-smoothstep(0.0,0.7,d),1.6));
          vec3 deep=vec3(0.03,0.04,0.06);
          vec3 water=mix(deep,refl,fres);
          // glints from the horizon light
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
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  const mouse = new THREE.Vector2(0.5, 0.5), mouseT = new THREE.Vector2(0.5, 0.5);
  const onMove = (e) => mouseT.set(e.clientX / innerWidth, 1 - e.clientY / innerHeight);
  window.addEventListener('pointermove', onMove);
  let energy = 0, target = 0, raf = 0, disposed = false; const t0 = performance.now();
  function frame() {
    if (disposed) return;
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    const s = renderer.getSize(new THREE.Vector2()); if (s.x !== w || s.y !== h) renderer.setSize(w, h, false);
    uniforms.uAspect.value = w / h;
    if (!reduced()) uniforms.uTime.value = (performance.now() - t0) / 1000;
    energy += (target - energy) * 0.03; uniforms.uEnergy.value = energy;
    mouse.lerp(mouseT, 0.04); uniforms.uMouse.value.copy(mouse);
    renderer.render(scene, camera); raf = requestAnimationFrame(frame);
  }
  frame();
  return { setEnergy(v) { target = v; }, dispose() { disposed = true; cancelAnimationFrame(raf); window.removeEventListener('pointermove', onMove); mat.dispose(); renderer.dispose(); } };
}

/* Dark ring gallery — real stills hung in a circle around the camera; drag / scroll turns it. */
export function mountRingDark(canvas, opts = {}) {
  const R = opts.radius ?? 7.2;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100); camera.position.set(0, 0, -R * 0.6);
  const loader = new THREE.TextureLoader();
  const geo = new THREE.PlaneGeometry(3.0, 1.6875);
  const planes = [], textures = [];
  (opts.images || []).forEach((src, i) => {
    const mat = new THREE.MeshBasicMaterial({ color: 0x9a9a9a, transparent: true, opacity: 0.98 });
    loader.load(src, (t) => { t.colorSpace = THREE.SRGBColorSpace; textures.push(t); mat.map = t; mat.needsUpdate = true; if (!disposed) renderer.render(scene, camera); });
    const m = new THREE.Mesh(geo, mat); m.userData = { i, a: (i / opts.images.length) * Math.PI * 2, glow: 0 };
    scene.add(m); planes.push(m);
    // faint reflection below
    const rm = new THREE.MeshBasicMaterial({ color: 0x9a9a9a, transparent: true, opacity: 0.12 });
    loader.load(src, (t) => { t.colorSpace = THREE.SRGBColorSpace; textures.push(t); rm.map = t; rm.needsUpdate = true; });
    const r = new THREE.Mesh(geo, rm); r.scale.y = -1; m.userData.refl = r; scene.add(r);
  });
  let scroll = 0, scrollT = 0, raf = 0, disposed = false, hovered = -1;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(9, 9), tilt = new THREE.Vector2(), tiltT = new THREE.Vector2();
  const onMove = (e) => { const b = canvas.getBoundingClientRect(); ndc.set(((e.clientX - b.left) / b.width) * 2 - 1, -(((e.clientY - b.top) / b.height) * 2 - 1)); tiltT.set(ndc.x * 0.3, ndc.y * 0.2); };
  const onLeave = () => { ndc.set(9, 9); tiltT.set(0, 0); };
  let dx = 0, dy = 0;
  const onDown = (e) => { dx = e.clientX; dy = e.clientY; };
  const onUp = (e) => { if (Math.hypot(e.clientX - dx, e.clientY - dy) > 6) return; if (hovered >= 0 && opts.onSelect) opts.onSelect(hovered); };
  canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp);
  const t0 = performance.now();
  function frame() {
    if (disposed) return;
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    const s = renderer.getSize(new THREE.Vector2()); if (s.x !== w || s.y !== h) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
    const t = (performance.now() - t0) / 1000;
    scroll += (scrollT - scroll) * 0.08; tilt.lerp(tiltT, 0.05);
    const rot = scroll * Math.PI * 2 + (reduced() ? 0 : t * 0.02);
    for (const m of planes) {
      const a = m.userData.a + rot;
      m.position.set(Math.sin(a) * R, 0.15, Math.cos(a) * R); m.rotation.y = a + Math.PI;
      const r = m.userData.refl; r.position.set(Math.sin(a) * R, -1.75, Math.cos(a) * R); r.rotation.y = a + Math.PI;
    }
    camera.position.set(tilt.x * 0.8, tilt.y * 0.5, -R * 0.6); camera.lookAt(tilt.x * 0.4, 0.1, R);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(planes, false)[0];
    const next = hit ? hit.object.userData.i : -1;
    if (next !== hovered) { hovered = next; if (opts.onHover) opts.onHover(hovered); }
    for (const m of planes) { const u = m.userData; u.glow += ((u.i === hovered ? 1 : 0) - u.glow) * 0.1; const c = 0.6 + u.glow * 0.4; m.material.color.setRGB(c, c, c); }
    canvas.style.cursor = hovered >= 0 ? 'pointer' : 'grab';
    renderer.render(scene, camera); raf = requestAnimationFrame(frame);
  }
  frame();
  return { setScroll(v) { scrollT = v; }, dispose() { disposed = true; cancelAnimationFrame(raf); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp); for (const m of planes) { m.material.dispose(); m.userData.refl.material.dispose(); } for (const t of textures) t.dispose(); geo.dispose(); renderer.dispose(); } };
}

/* Drifting contour lines — a fullscreen fbm field sliced into thin isolines. */
export function mountContours(canvas, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;
  const uniforms = {
    uTime: { value: 0 }, uAspect: { value: 1 }, uMouse: { value: new THREE.Vector2(9, 9) },
    uInk: { value: new THREE.Color(opts.ink || '#bab6b6') }, uAccent: { value: new THREE.Color(opts.accent || '#ec3013') },
    uLines: { value: opts.lines ?? 14 }, uEnergy: { value: 0 }, uPx: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position,1.0); }`,
    fragmentShader: `
      precision highp float; varying vec2 vUv;
      uniform float uTime,uAspect,uLines,uEnergy,uPx; uniform vec2 uMouse; uniform vec3 uInk,uAccent;
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
      float fbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<5;i++){ v+=a*noise(p); p=p*2.03+vec2(1.7,9.2); a*=0.5; } return v; }
      void main(){
        vec2 p=vUv*vec2(uAspect,1.0);
        float t=uTime*0.025;
        vec2 m=uMouse*vec2(uAspect,1.0);
        float dm=length(p-m);
        float push=smoothstep(0.6,0.0,dm)*0.08;
        float n=fbm(p*1.35+vec2(t,-t*0.6))+push+uEnergy*0.15*sin(uTime*1.5+p.y*4.0);
        float k=n*uLines;
        float d=abs(fract(k)-0.5);
        float w=fwidth(k)*1.1;
        float line=1.0-smoothstep(0.0,w+0.02,d);
        float idx=floor(k);
        float accent=step(0.9,fract(idx*0.618+0.1))*uEnergy;
        vec3 col=mix(uInk,uAccent,accent);
        float fade=smoothstep(0.0,0.35,vUv.y)*0.9+0.1;
        gl_FragColor=vec4(col,line*(0.55+uEnergy*0.3)*fade);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  const mouse = new THREE.Vector2(9, 9), mouseT = new THREE.Vector2(9, 9);
  const onMove = (e) => { const b = canvas.getBoundingClientRect(); mouseT.set((e.clientX - b.left) / b.width, 1 - (e.clientY - b.top) / b.height); };
  const onLeave = () => mouseT.set(9, 9);
  canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerleave', onLeave);
  let energy = 0, target = 0, raf = 0, disposed = false; const t0 = performance.now();
  function frame() {
    if (disposed) return;
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    const s = renderer.getSize(new THREE.Vector2()); if (s.x !== w || s.y !== h) renderer.setSize(w, h, false);
    uniforms.uAspect.value = w / h;
    if (!reduced()) uniforms.uTime.value = (performance.now() - t0) / 1000;
    energy += (target - energy) * 0.04; uniforms.uEnergy.value = energy;
    mouse.lerp(mouseT, 0.06); uniforms.uMouse.value.copy(mouse);
    renderer.render(scene, camera); raf = requestAnimationFrame(frame);
  }
  frame();
  return { setEnergy(v) { target = v; }, dispose() { disposed = true; cancelAnimationFrame(raf); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerleave', onLeave); mat.dispose(); renderer.dispose(); } };
}
