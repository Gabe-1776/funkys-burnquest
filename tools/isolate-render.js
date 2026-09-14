// Renders each baked car JSON alone under NEUTRAL white light, so what you see
// is the asset's own albedo with no theme tint in the way. Used to compare a
// baked asset against its Meshy reference plate without the scene lighting,
// tone mapping or warm sun confusing the judgement.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const NAMES = process.argv.slice(2);
const ROOT = __dirname + '/..';

(async () => {
  const srv = http.createServer((rq, rs) => {
    const f = path.join(ROOT, decodeURIComponent(rq.url.split('?')[0]));
    fs.readFile(f, (e, d) => e ? (rs.writeHead(404), rs.end())
      : (rs.writeHead(200, {'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/json'}), rs.end(d)));
  }).listen(8123);

  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 520, height: 400 } });
  await p.goto('http://127.0.0.1:8123/index.html');
  await p.setContent('<canvas id=c width=520 height=400></canvas>');
  await p.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.min.js' });

  for (const name of NAMES) {
    const hex = await p.evaluate(async (n) => {
      const d = await (await fetch('/assets/models/fv/' + n + '.json')).json();
      const sc = new THREE.Scene(); sc.background = new THREE.Color(0xf2f2f2);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(d.positions, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(d.normals, 3));
      if (d.colors) g.setAttribute('color', new THREE.Float32BufferAttribute(d.colors, 3));
      g.setIndex(d.indices);
      // UNLIT on purpose. A lit material reports the shaded result, not the
      // albedo - an earlier version of this tool used MeshStandard and made the
      // taxi look olive when its baked colour is a correct bright yellow.
      const m = new THREE.MeshBasicMaterial({ vertexColors: !!d.colors, color: 0xffffff });
      const mesh = new THREE.Mesh(g, m); sc.add(mesh);
      sc.add(new THREE.HemisphereLight(0xffffff, 0xbbbbbb, 1.6));
      const dl = new THREE.DirectionalLight(0xffffff, 1.1); dl.position.set(2, 3, 2); sc.add(dl);
      g.computeBoundingBox(); const bb = g.boundingBox;
      const c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3());
      const cam = new THREE.PerspectiveCamera(35, 520/400, 0.01, 100);
      const r = Math.max(s.x, s.y, s.z);
      cam.position.set(c.x + r*1.7, c.y + r*1.1, c.z + r*2.0); cam.lookAt(c);
      const rn = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true });
      rn.outputColorSpace = THREE.SRGBColorSpace; rn.render(sc, cam);
      // dominant saturated colour of the rendered isolate
      const cv = document.getElementById('c'), gg = document.createElement('canvas');
      gg.width = cv.width; gg.height = cv.height;
      gg.getContext('2d').drawImage(cv, 0, 0);
      const px = gg.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
      const bk = {};
      for (let i = 0; i < px.length; i += 4) {
        const R=px[i]/255, G=px[i+1]/255, B=px[i+2]/255;
        const mx=Math.max(R,G,B), mn=Math.min(R,G,B), sa=mx?(mx-mn)/mx:0;
        if (sa < 0.35 || mx < 0.25) continue;
        let h; if(mx===R)h=((G-B)/(mx-mn))%6; else if(mx===G)h=(B-R)/(mx-mn)+2; else h=(R-G)/(mx-mn)+4;
        h=((h*60)+360)%360; const k=Math.round(h/15)*15;
        bk[k]=bk[k]||{n:0,r:0,g:0,b:0}; bk[k].n++; bk[k].r+=R; bk[k].g+=G; bk[k].b+=B;
      }
      const top = Object.entries(bk).sort((a,b)=>b[1].n-a[1].n)[0];
      if (!top) return 'none';
      const v = top[1], f = x => Math.round(x/v.n*255).toString(16).padStart(2,'0');
      return '#' + f(v.r) + f(v.g) + f(v.b) + ' (' + v.n + 'px)';
    }, name);
    await p.screenshot({ path: `${ROOT}/test-shots/isolate-${name}.png` });
    console.log(`  ${name.padEnd(16)} albedo ${hex}`);
  }
  await b.close(); srv.close();
})();
