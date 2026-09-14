"""Bake a GLB to game JSON with texture sampled onto VERTEX COLORS.

Run headless:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/bake_car_meshy_vc.py

This is the fix for Meshy's baked texture not surviving the flat-color JSON:
sample the baseColor texture onto per-vertex colors so the in-game loader
(buildModelMesh reads data.colors as a color attribute) shows the real look.
Reuses the proven sample/uv helpers from bake_trellis_glb.py.
"""
import bpy, json, os, sys
sys.path.insert(0, os.path.expanduser("~/Developer/funkys-burnquest/tools"))
from bake_trellis_glb import (  # reuse helpers
    reset_scene, import_glb, join_meshes, bake_vertex_colors,
)

argv = sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
GLB = argv[0] if argv else "test-shots/pipeline-car/car_meshy_tex.glb"
SLUG = argv[1] if len(argv)>1 else "car_meshy"
ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
OUT = os.path.join(ROOT, "assets/models/bakeoff/%s.json" % SLUG)

def bake_vc(obj, slug):
    me = obj.data
    # sample texture -> vertex colors (reuses bake_trellis_glb logic)
    colors = bake_vertex_colors(obj)
    me.calc_loop_triangles()
    mats=[]
    for m in (me.materials or []):
        n=m.node_tree.nodes.get("Principled BSDF") if m.use_nodes else None
        c=n.inputs["Base Color"].default_value if n else (1,1,1,1)
        r=n.inputs["Roughness"].default_value if n else 0.6
        mats.append({"name":m.name,"color":[round(c[0],4),round(c[1],4),round(c[2],4)],"roughness":round(r,3),"emissive":0.0})
    if not mats: mats=[{"name":"Material_0","color":[0.85,0.6,0.85],"roughness":0.5,"emissive":0.0}]
    by_mat={}
    for t in me.loop_triangles: by_mat.setdefault(t.material_index,[]).append(t)
    pos,nrm,col,idx,groups,vmap=[],[],[],[],[],{}
    total_mi=0
    for mi in sorted(by_mat):
        start=len(idx)
        for t in by_mat[mi]:
            for li in t.loops:
                loop=me.loops[li]; v=me.vertices[loop.vertex_index]
                n_=loop.normal if t.use_smooth else t.normal
                # vertex color for this vertex
                c=colors[v.index] if v.index < len(colors) else (0.7,0.7,0.7)
                key=(loop.vertex_index,round(n_.x,4),round(n_.y,4),round(n_.z,4),mi)
                i=vmap.get(key)
                if i is None:
                    i=len(pos)//3; vmap[key]=i
                    pos.extend([round(v.co.x,4),round(v.co.z,4),round(-v.co.y,4)])
                    nrm.extend([round(n_.x,4),round(n_.z,4),round(-n_.y,4)])
                    col.extend([round(c[0],4),round(c[1],4),round(c[2],4)])
                idx.append(i)
        groups.append({"start":start,"count":len(idx)-start,"materialIndex":mi})
        total_mi+=1
    os.makedirs(os.path.dirname(OUT),exist_ok=True)
    with open(OUT,"w") as f:
        json.dump({"name":slug,"materials":mats,"groups":groups,
                   "positions":pos,"normals":nrm,"colors":col,"indices":idx},f)
    print("BAKED_VERTCOLOR %s: %d verts, %d tris, %d groups -> %s"%(slug,len(pos)//3,len(idx)//3,total_mi,OUT))

reset_scene()
meshes=import_glb(GLB)
obj=join_meshes(meshes,"Car")
bake_vc(obj,SLUG)
