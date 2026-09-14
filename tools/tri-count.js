const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1280,height:800}});
await p.goto('http://localhost:8788/index.html?render=3d&debug=1',{waitUntil:'networkidle'});
await p.waitForTimeout(4000);
const r=await p.evaluate(()=>{let tris=0,meshes=0,hidden=0;
 window.__scene.traverse(o=>{if(!o.isMesh)return;
  let vis=o.visible,q=o.parent;while(vis&&q){vis=q.visible;q=q.parent;}
  if(!vis){hidden++;return;}
  meshes++;const g=o.geometry;const n=g.index?g.index.count/3:g.attributes.position.count/3;
  tris+=n*(o.isInstancedMesh?o.count:1);});
 return{tris,meshes,hidden};});
console.log('visible meshes:',r.meshes,'| hidden:',r.hidden,'| triangles:',Math.round(r.tris).toLocaleString());
await b.close();})();
