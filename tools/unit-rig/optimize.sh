#!/bin/sh
# Simplify one unit's high-poly source to about 25k triangles with a 1024px JPEG texture.
# Usage, from tools/unit-rig/work: ../optimize.sh <race> <unit>
set -eu
race="$1"; unit="$2"
src="../../../assets/units/$race/$unit/$unit.source.glb"
faces=$(node -e "const fs=require('fs');const b=fs.readFileSync(process.argv[1]);const l=b.readUInt32LE(12);const j=JSON.parse(b.subarray(20,20+l));let f=0;for(const m of j.meshes)for(const p of m.primitives)f+=j.accessors[p.indices].count/3;console.log(f)" "$src")
ratio=$(node -e "console.log((25000/$faces).toFixed(5))")
npx gltf-transform simplify "$src" "$unit.s.glb" --ratio "$ratio" --error 0.002
npx gltf-transform resize "$unit.s.glb" "$unit.r.glb" --width 1024 --height 1024
npx gltf-transform jpeg "$unit.r.glb" "$unit.light.glb" --quality 85
rm -f "$unit.s.glb" "$unit.r.glb"
