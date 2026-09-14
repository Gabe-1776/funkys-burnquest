const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const NAME = process.argv[2], ROOT = __dirname + '/..';
(async () => {
  const srv = http.createServer((rq, rs) => {
    const f = path.join(ROOT, decodeURIComponent(rq.url.split('?')[0]));
    fs.readFile(f, (e, d) => e ? (rs.writeHead(404), rs.end())
      : (rs.writeHead(200, {'Content-Type': f.endsWith('.html') ? 'text/html' : 'application/json'}), rs.end(d)));
  }).listen(8124);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 900, height: 620 } });
  await p.goto('http://127.0.0.1:8124/index.html');
  await p.setContent('<canvas id=c width=900 height=620></canvas>');
  await p.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.min.js' });
  await p.evaluate(async ([n, DS, THEME]) => {
    const d = await (await fetch('/assets/models/' + THEME + '/' + n + '.json')).json();
    const sc = new THREE.Scene(); sc.background = new THREE.Color(0xf2f2f2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(d.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(d.normals, 3));
    if (d.colors) g.setAttribute('color', new THREE.Float32BufferAttribute(d.colors, 3));
    g.setIndex(d.indices);
    sc.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: !!d.colors, side: DS ? THREE.DoubleSide : THREE.FrontSide })));
    g.computeBoundingBox(); const bb = g.boundingBox;
    const c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3());
    const cam = new THREE.PerspectiveCamera(30, 900/620, 0.01, 100);
    const r = Math.max(s.x, s.y, s.z);
    // straight at the flank, slightly above - that is where the stripe lives
    cam.position.set(c.x, c.y + r * 0.35, c.z + r * 1.9); cam.lookAt(c);
    const rn = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true });
    rn.outputColorSpace = THREE.SRGBColorSpace; rn.render(sc, cam);
  }, [NAME, !!process.env.DS, process.env.THEME || 'fv']);
  await p.screenshot({ path: `${ROOT}/test-shots/zoom-${process.env.THEME || 'fv'}-${NAME}.png` });
  await b.close(); srv.close();
})();
