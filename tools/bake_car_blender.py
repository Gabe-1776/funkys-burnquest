"""Bake the pipeline coupe to the game's compact JSON mesh (v2 — extruded profile).

Run headless:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/bake_car_blender.py

v2: the body is a SIDE PROFILE traced from the ortho (front +X, ground z=0), then
extruded across width (Y). This gives a real fastback silhouette instead of
stacked boxes. Wheels, flares, splitter, wing, lights, glass added after.
"""
import bpy, json, os, math

ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
OUT = os.path.join(ROOT, "assets/models/bakeoff/car_blender.json")

def clean_scene():
    bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete(use_global=False)
    for b in list(bpy.data.meshes): bpy.data.meshes.remove(b)

def mat(name, rgb, rough=0.5, metal=0.0, emit=None, es=0.0):
    m=bpy.data.materials.new(name); m.use_nodes=True
    b=m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value=(*rgb,1.0); b.inputs["Roughness"].default_value=rough
    b.inputs["Metallic"].default_value=metal
    if emit:
        b.inputs["Emission Color"].default_value=(*emit,1.0); b.inputs["Emission Strength"].default_value=es
    return m

def make_profile_body(parts):
    """Side profile (x=length, z=height) extruded across width. Points traced from
    the side ortho: nose low, hood rise, windshield, roof, fastback to tail."""
    # (x, z) bottom + top outline, counter-clockwise-ish, x forward(+). Car spans x[-2.2,2.3].
    profile = [
        (2.30,0.16),(2.30,0.34),      # nose front face
        (2.05,0.46),(1.55,0.58),      # hood rise
        (1.20,0.62),(0.80,1.02),      # windshield
        (-0.10,1.12),(-0.60,1.10),    # roof
        (-1.15,0.92),(-1.75,0.74),    # fastback
        (-2.20,0.66),(-2.20,0.30),    # tail
        (-1.95,0.24),(0.00,0.20),     # rocker bottom
        (1.55,0.20),(2.30,0.16),      # back to nose
    ]
    WID=1.6
    verts=[]; faces=[]
    nz=len(profile)
    for (x,z) in profile: verts.append((x,-WID/2,z))     # left wall
    for (x,z) in profile: verts.append((x, WID/2,z))     # right wall
    # side faces (fill the outline on each side) - use a fan-based fill via ngon
    faces.append(tuple(range(nz)))                       # left ngon (indices 0..nz-1)
    faces.append(tuple(range(nz,2*nz)))                  # right ngon
    # connect the two rims
    for i in range(nz):
        a=i; b=(i+1)%nz; c=nz+(i+1)%nz; d=nz+i
        faces.append((a,b,c,d))
    mesh=bpy.data.meshes.new("BodyMesh"); mesh.from_pydata(verts,[],faces); mesh.update()
    body=bpy.data.objects.new("Body",mesh)
    bpy.context.collection.objects.link(body)
    # material is assigned by caller via slot 0
    parts.append((body,'paint'))
    return body

def add_box(name,size,loc,rot=(0,0,0)):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc)
    o=bpy.context.active_object; o.name=name; o.scale=(size[0],size[1],size[2]); o.rotation_euler=rot
    return o

def make_car():
    M={
      'paint':mat("CarPaint",(0.78,0.12,0.72),0.25,0.1),
      'black':mat("BlackTrim",(0.03,0.03,0.04),0.7),
      'glass':mat("Canopy",(0.16,0.05,0.28),0.08),
      'chrome':mat("Chrome",(0.85,0.86,0.9),0.08,1.0),
      'rim_pink':mat("RimLip",(0.9,0.1,0.7),0.25,0.6),
      'cyan':mat("CyanTrim",(0.0,0.9,1.0),0.2,emit=(0,0.9,1.0),es=1.5),
      'headlight':mat("Headlight",(0.7,0.95,1.0),0.1,emit=(0.5,0.95,1.0),es=3.0),
      'taillight':mat("Taillight",(1.0,0.1,0.7),0.1,emit=(1.0,0.1,0.7),es=2.5),
      'tire':mat("Tire",(0.02,0.02,0.02),0.9),
      'carbon':mat("Carbon",(0.05,0.05,0.06),0.4,0.3),
    }
    parts=[]
    body=make_profile_body(parts)
    WID=1.6; AXLE_Z=0.32; WHEEL_R=0.32; LEN=4.5
    # canopy glass (roof insert)
    canopy=add_box("Canopy",(1.05,1.15,0.16),(0.12,0,1.02)); parts.append((canopy,'glass'))
    cyan=add_box("CyanTrim",(1.10,1.22,0.045),(0.12,0,1.10)); parts.append((cyan,'cyan'))
    # splitter
    split=add_box("Splitter",(0.5,1.66,0.10),(2.22,0,0.16)); parts.append((split,'black'))
    # fender flares
    for fx in (1.35,-1.35):
        for sy in (-1,1):
            fl=add_box("Flare",(0.75,0.18,0.26),(fx,sy*0.82,0.36)); parts.append((fl,'black'))
    # side skirts
    for sy in (-1,1):
        sk=add_box("Skirt",(2.6,0.10,0.16),(0.0,sy*0.80,0.22)); parts.append((sk,'black'))
    # rear diffuser
    diff=add_box("Diffuser",(0.45,1.6,0.18),(-2.05,0,0.20)); parts.append((diff,'black'))
    # wing — uprights must SINK INTO the rear deck (roof ~1.12) so they read as
    # attached, not floating. Base of upright at ~0.95, top plane just above.
    for sy in (-1,1):
        up=add_box("WingUpright",(0.5,0.10,0.60),(-1.85,sy*0.58,1.05),rot=(0,-0.22,0)); parts.append((up,'paint'))
        ep=add_box("WingEndplate",(0.66,0.05,0.34),(-1.90,sy*0.66,1.36)); parts.append((ep,'paint'))
    wingtop=add_box("WingTop",(0.72,1.5,0.06),(-1.86,0,1.52),rot=(0,-0.10,0)); parts.append((wingtop,'carbon'))
    # wheels
    for fx in (1.35,-1.35):
        for sy in (-1,1):
            bpy.ops.mesh.primitive_cylinder_add(radius=WHEEL_R,depth=0.22,vertices=20,location=(fx,sy*0.82,AXLE_Z),rotation=(math.pi/2,0,0))
            t=bpy.context.active_object; t.name="Tire"; parts.append((t,'tire'))
            bpy.ops.mesh.primitive_cylinder_add(radius=WHEEL_R*0.6,depth=0.12,vertices=16,location=(fx,sy*0.88,AXLE_Z),rotation=(math.pi/2,0,0))
            r=bpy.context.active_object; r.name="Rim"; parts.append((r,'chrome'))
            bpy.ops.mesh.primitive_torus_add(major_radius=WHEEL_R*0.58,minor_radius=0.04,major_segments=20,minor_segments=6,location=(fx,sy*0.92,AXLE_Z),rotation=(math.pi/2,0,0))
            lip=bpy.context.active_object; lip.name="RimLip"; parts.append((lip,'rim_pink'))
    # lights
    for sy in (-1,1):
        hl=add_box("Headlight",(0.10,0.26,0.15),(2.44,sy*0.5,0.50)); parts.append((hl,'headlight'))
        tl=add_box("Taillight",(0.08,0.34,0.18),(-2.44,sy*0.48,0.52)); parts.append((tl,'taillight'))
    # assign
    objs=[]
    for o,mn in parts:
        d=bpy.data.materials[{'paint':'CarPaint','black':'BlackTrim','glass':'Canopy','chrome':'Chrome','rim_pink':'RimLip','cyan':'CyanTrim','headlight':'Headlight','taillight':'Taillight','tire':'Tire','carbon':'Carbon'}[mn]]
        o.data.materials.clear(); o.data.materials.append(d)
        objs.append(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active=objs[0]; bpy.ops.object.join()
    car=bpy.context.active_object; car.name="Car"
    bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)

    # WELD: join() keeps parts as separate loose shells. Merge coincident verts
    # so the body/wing/flares fuse into a contiguous surface instead of a pile of
    # floating islands (this is what made the wing read as detached).
    bpy.context.view_layer.objects.active = car
    car.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.02)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    return car

def bake(car,out_slug):
    me=car.data; me.calc_loop_triangles()
    mats=[]
    for m in me.materials:
        n=m.node_tree.nodes.get("Principled BSDF") if m.use_nodes else None
        c=n.inputs["Base Color"].default_value if n else (1,1,1,1)
        r=n.inputs["Roughness"].default_value if n else 0.6
        mats.append({"name":m.name,"color":[round(c[0],4),round(c[1],4),round(c[2],4)],"roughness":round(r,3),"emissive":0.0})
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
        json.dump({"name":out_slug,"materials":mats,"groups":groups,"positions":pos,"normals":nrm,"indices":idx},f)
    print("BAKED %s: %d verts, %d tris, %d materials -> %s"%(out_slug,len(pos)//3,len(idx)//3,len(mats),OUT))

clean_scene(); car=make_car(); bake(car,"car_blender")
