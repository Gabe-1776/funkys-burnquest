"""Bake a GLB to the game's compact JSON mesh format (generic).

Run headless:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/bake_glb_generic.py -- <glb> <out_slug>
"""
import bpy, json, os, sys

argv = sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
GLB = argv[0] if argv else "test-shots/pipeline-car/car_meshy.glb"
SLUG = argv[1] if len(argv)>1 else "car_meshy"
ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
OUT = os.path.join(ROOT, "assets/models/bakeoff/%s.json" % SLUG)

def reset_scene(): bpy.ops.wm.read_factory_settings(use_empty=True)
def import_glb(path):
    before=set(bpy.data.objects); ok=False
    for op in (lambda: bpy.ops.import_scene.gltf(filepath=path), lambda: bpy.ops.wm.gltf_import(filepath=path)):
        try: op(); ok=True; break
        except Exception as e: print("import fail: %s"%e)
    if not ok: raise RuntimeError("could not import %s"%path)
    return [o for o in bpy.data.objects if o not in before or o.type=="MESH"]
def join(meshes,name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes: o.hide_set(False); o.hide_viewport=False; o.select_set(True)
    bpy.context.view_layer.objects.active=meshes[0]; bpy.ops.object.join()
    obj=bpy.context.active_object; obj.name=name
    bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
    return obj
def bake(obj,slug):
    me=obj.data; me.calc_loop_triangles()
    mats=[]
    for m in me.materials:
        n=m.node_tree.nodes.get("Principled BSDF") if m.use_nodes else None
        c=n.inputs["Base Color"].default_value if n else (1,1,1,1)
        r=n.inputs["Roughness"].default_value if n else 0.6
        e=n.inputs["Emission Strength"].default_value if n and "Emission Strength" in n.inputs else 0.0
        mats.append({"name":m.name if m.name else "mat%d"%len(mats),
                     "color":[round(c[0],4),round(c[1],4),round(c[2],4)],
                     "roughness":round(r,3),"emissive":round(e,3)})
    by_mat={}
    for t in me.loop_triangles: by_mat.setdefault(t.material_index,[]).append(t)
    pos,nrm,idx,groups,vmap=[],[],[],[],{}
    for mi in sorted(by_mat):
        start=len(idx)
        for t in by_mat[mi]:
            for li in t.loops:
                loop=me.loops[li]; v=me.vertices[loop.vertex_index]
                n_=loop.normal if t.use_smooth else t.normal
                key=(loop.vertex_index,round(n_.x,4),round(n_.y,4),round(n_.z,4),mi)
                i=vmap.get(key)
                if i is None:
                    i=len(pos)//3; vmap[key]=i
                    pos.extend([round(v.co.x,4),round(v.co.z,4),round(-v.co.y,4)])
                    nrm.extend([round(n_.x,4),round(n_.z,4),round(-n_.y,4)])
                idx.append(i)
        groups.append({"start":start,"count":len(idx)-start,"materialIndex":mi})
    os.makedirs(os.path.dirname(OUT),exist_ok=True)
    with open(OUT,"w") as f:
        json.dump({"name":slug,"materials":mats,"groups":groups,"positions":pos,"normals":nrm,"indices":idx},f)
    print("BAKED %s: %d verts, %d tris, %d materials -> %s"%(slug,len(pos)//3,len(idx)//3,len(mats),OUT))

reset_scene()
meshes=import_glb(GLB)
obj=join(meshes,"Car")
bake(obj,SLUG)
