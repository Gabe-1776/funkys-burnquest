# Exporting a Blender model into the game

The game is a plain `<script>` project with no build step, and three.js r0.160's
UMD build has **no GLTFLoader** (the `examples/js` loaders were removed after
r0.147). An importmap would work but the house black-screen notes warn it is
fragile in Safari. So models are **baked to compact JSON** at export time and
turned into a `BufferGeometry` at runtime — no loader, no CDN dependency.

Source of truth: `assets/models/funky.blend` (re-openable, all parts joined).
`funky.glb` is kept as an interchange copy; the game does not read it.

## Re-export after editing

With Blender running and the MCP addon server started, run this in Blender:

```python
obj = bpy.data.objects["Funky"]; me = obj.data; me.calc_loop_triangles()
# ... group loop_triangles by material_index, emit positions/normals/indices
# ... Blender is Z-up, three.js is Y-up:  (x, y, z) -> (x, z, -y)
```

The full script is in this session's history; the important parts are:

- **Axis conversion is mandatory.** Blender Z-up to three.js Y-up is
  `(x, z, -y)` for BOTH positions and normals. Skip the normals and the
  lighting is silently wrong.
- **Emit one `group` per material** (`{start, count, materialIndex}`) and pass
  an ARRAY of materials to the `Mesh`, so one geometry carries all five colours.
- **Model faces -Y in Blender**, which becomes **+Z** in three.js — that is
  "toward the goal", so `faceOffset` is 0. The placeholder box faced -Z and
  needs `Math.PI`. `render3d.js` reads `frogMesh.userData.faceOffset` so the
  facing maths does not care which is showing.
- Apply bevel modifiers and join before exporting, then set origin to the base
  so the game can sit it on the tile floor.

## Starting Blender for MCP

Blender must be RUNNING with the addon server listening on `localhost:9876`:

```bash
/Applications/Blender.app/Contents/MacOS/Blender --python - <<'PY'
import bpy
bpy.app.timers.register(lambda: (bpy.ops.blendermcp.start_server(), None)[1], first_interval=2.0)
PY
```

Verify: `lsof -nP -iTCP:9876 -sTCP:LISTEN`
