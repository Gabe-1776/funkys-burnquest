// Render one GLB alone, side-on, under neutral light - so a texture edit can be
// checked on the asset itself instead of hunting for it in a game screenshot
// where the camera only ever shows the roof and one flank at a distance.
//
// Usage: node tools/glb-side-shot.js assets/models/glb/fv/truck-purple.glb [out.png]
const { chromium } = require('playwright');
const fs = require('fs');

const GLB = process.argv[2];
const OUT = process.argv[3] || 'test-shots/glb-side.png';
// Elevation in degrees: 0 = straight at the flank, 90 = straight down.
// The game camera looks down at roughly 50 degrees, which is the angle
// that matters for 'what does the player actually see on top'.
const ELEV = parseFloat(process.argv[4] || '8');
// Azimuth in degrees: 0 = +z side, 180 = the opposite flank.
const AZ = parseFloat(process.argv[5] || '0');

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1000, height: 520 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 140)); });
  await p.goto('http://127.0.0.1:8099/index.html?render=3d&debug=1', { waitUntil: 'load' });
  await p.waitForTimeout(2500);

  const res = await p.evaluate(async ({ glb, elev, az }) => {
    const THREE = window.THREE;
    // Reuse the page's GLTFLoader shim, already bound to the global THREE.
    await new Promise((ok, fail) => {
      if (THREE.GLTFLoader) return ok();
      const s = document.createElement('script');
      s.src = 'glb-loader.js'; s.onload = ok; s.onerror = fail;
      document.head.appendChild(s);
    });
    const gltf = await new Promise((ok, fail) =>
      new THREE.GLTFLoader().load(glb, ok, undefined, fail));
    const root = gltf.scene;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf2f2f4);
    scene.add(new THREE.AmbientLight(0xffffff, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(2, 3, 4); scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 1.0);
    fill.position.set(-3, 1, -2); scene.add(fill);
    scene.add(root);

    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const mid = box.getCenter(new THREE.Vector3());

    const cam = new THREE.PerspectiveCamera(30, 1000 / 520, 0.01, 100);
    // Straight at the flank, slightly above: the side is what carries the tag.
    const dist = Math.max(size.x, size.y) * 2.6;
    const e = elev * Math.PI / 180;
    const a = az * Math.PI / 180;
    const horiz = Math.cos(e) * dist;
    cam.position.set(mid.x + Math.sin(a) * horiz,
                     mid.y + Math.sin(e) * dist + size.y * 0.15,
                     mid.z + Math.cos(a) * horiz);
    cam.lookAt(mid);

    const cv = document.createElement('canvas');
    cv.width = 2000; cv.height = 1040;
    const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
    r.setSize(1000, 520, false);
    if ('outputColorSpace' in r) r.outputColorSpace = THREE.SRGBColorSpace;
    r.render(scene, cam);
    return { png: cv.toDataURL('image/png'),
             size: [ +size.x.toFixed(3), +size.y.toFixed(3), +size.z.toFixed(3) ] };
  }, { glb: GLB, elev: ELEV, az: AZ });

  fs.writeFileSync(OUT, Buffer.from(res.png.split(',')[1], 'base64'));
  console.log(`${GLB} size ${res.size.join(' x ')} -> ${OUT}`);
  if (errs.length) console.log('console errors:', errs.slice(0, 3));
  await b.close();
})();
