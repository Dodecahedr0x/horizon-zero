import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneModel } from "three/examples/jsm/utils/SkeletonUtils.js";
import catalog from "../../content/catalog.json" with { type: "json" };
import { parseTraceLine } from "../../content/trace.mjs";

const INK = "#0e0a08";
const SKY = "#120f0d";
const ALLY = "#e8763a";
const FOE = "#8fb4d0";
const TILE = ["#6e645a", "#62594f"];
const ALLY_ZONE = "#8f5b3c";
const FOE_ZONE = "#56656e";
const RUBBLE = "#3b2e26";
const TINT_FLOOR = ["#ffffff", "#e6ddd2"];
const TINT_ALLY = "#ffb070";
const TINT_FOE = "#aabdc8";
const ZONE_DEPTH = 2;
const HIT_AT = 0.34;
const UNIT_HEIGHT = 0.95;

const ramp = toonRamp();
// Units keep three hard bands but stay brighter, so their painted textures read at board size.
const unitRamp = toonRamp([170, 220, 255]);
// A warm self-light so units read against the dark stone floor.
const UNIT_GLOW = "#3b2a1c";
const loader = new GLTFLoader();
const templates = new Map();

// Races and units come from content/catalog.json, the same file the game and the studio read.
function catalogUnit(raceId, kind) {
  const race = catalog.races.find((item) => item.id === Number(raceId)) || catalog.races[0];
  return { race, unit: race.units.find((item) => item.id === Number(kind)) };
}

export function unitMeshUrl(raceId, kind) {
  const { race, unit } = catalogUnit(raceId, kind);
  const name = unit ? unit.name.toLowerCase() : "missing";
  return `/assets/units/${race.slug}/${name}/${name}.approved.glb`;
}

function unitColor(raceId, kind) {
  return catalogUnit(raceId, kind).unit?.color || "#e2d6c0";
}

function deploy(side, rows, unit) {
  return { col: unit.col, row: side === 0 ? unit.row : rows - 1 - unit.row };
}

function toonRamp(bands = [90, 170, 255]) {
  const texture = new THREE.DataTexture(Uint8Array.from(bands), 3, 1, THREE.RedFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function outlineMaterial(thickness) {
  const material = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.outline = { value: thickness };
    shader.vertexShader = `uniform float outline;\n${shader.vertexShader.replace(
      "#include <begin_vertex>",
      "vec3 transformed = vec3( position ) + normal * outline;",
    )}`;
  };
  return material;
}

function toonify(root, thickness, bands = ramp, glow = null) {
  const outline = outlineMaterial(thickness);
  const meshes = [];
  root.traverse((child) => {
    if (child.isMesh) meshes.push(child);
  });
  for (const mesh of meshes) {
    const swap = (material) => new THREE.MeshToonMaterial({
      color: material.color || new THREE.Color("#ffffff"),
      map: material.map || null,
      gradientMap: bands,
      emissive: new THREE.Color(glow || "#000000"),
    });
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    if (!mesh.isSkinnedMesh) {
      mesh.add(new THREE.Mesh(mesh.geometry, outline));
    } else if (mesh.parent) {
      // A skinned hull bound to the same skeleton, so the ink line bends with the body.
      const hull = new THREE.SkinnedMesh(mesh.geometry, outline);
      hull.name = `${mesh.name}-outline`;
      hull.position.copy(mesh.position);
      hull.quaternion.copy(mesh.quaternion);
      hull.scale.copy(mesh.scale);
      hull.bind(mesh.skeleton, mesh.bindMatrix);
      hull.frustumCulled = false;
      mesh.parent.add(hull);
    }
  }
}

function ring(color) {
  const group = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.27, 0.46, 32), new THREE.MeshBasicMaterial({ color: INK }));
  const band = new THREE.Mesh(new THREE.RingGeometry(0.31, 0.42, 32), new THREE.MeshBasicMaterial({ color }));
  rim.rotation.x = band.rotation.x = -Math.PI / 2;
  band.position.y = 0.002;
  group.add(rim, band);
  return group;
}

// Lasting cast effects, by engine effect id: a thin aura ring outside the side ring while they hold.
const STATUS_AURAS = { sprint: { color: "#ffcb45", label: "Sprint" }, reach: { color: "#7cc4ff", label: "Reach" }, taunt: { color: "#e0483e", label: "Taunt" } };

function aura(color, step) {
  const inner = 0.5 + step * 0.09;
  const band = new THREE.Mesh(new THREE.RingGeometry(inner, inner + 0.06, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
  band.rotation.x = -Math.PI / 2;
  band.position.y = 0.05;
  return band;
}

function setStatus(fighter, effect, on) {
  fighter.statuses = fighter.statuses || new Map();
  const held = fighter.statuses.get(effect);
  if (on && !held && STATUS_AURAS[effect]) {
    const mesh = aura(STATUS_AURAS[effect].color, fighter.statuses.size);
    fighter.group.add(mesh);
    fighter.statuses.set(effect, mesh);
  }
  if (!on && held) {
    fighter.group.remove(held);
    fighter.statuses.delete(effect);
    // Close the gap so the remaining auras stay packed against the side ring.
    [...fighter.statuses.entries()].forEach(([id, mesh], step) => {
      fighter.group.remove(mesh);
      const next = aura(STATUS_AURAS[id].color, step);
      fighter.group.add(next);
      fighter.statuses.set(id, next);
    });
  }
}

function clearStatuses(fighter) {
  for (const effect of [...(fighter.statuses?.keys() || [])]) setStatus(fighter, effect, false);
}

function placeholderMesh(color) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.72, 0.42),
    new THREE.MeshStandardMaterial({ color }),
  );
  toonify(mesh, 0.03);
  mesh.name = "unit-placeholder";
  mesh.position.y = 0.41;
  return mesh;
}

function actionForClip(name) {
  const tokens = String(name || "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const has = (...words) => words.some((word) => tokens.includes(word));
  if (has("idle", "stance")) return "idle";
  if (has("defend", "block", "parry")) return "defend";
  if (has("death", "dead", "dying", "die")) return "death";
  if (has("run", "running")) return "run";
  if (has("attack", "attacking")) return "attack";
  if (has("cast", "casting")) return "cast";
  if (has("hurt", "hit", "gothit", "gethit") || (has("got") && has("hit"))) return "hit";
  return null;
}

function clipMap(animations) {
  const clips = {};
  for (const clip of animations || []) {
    const action = actionForClip(clip.name);
    if (action && !clips[action]) clips[action] = clip;
  }
  return clips;
}

function loadTemplate(url) {
  let pending = templates.get(url);
  if (!pending) {
    pending = loader.loadAsync(url).then((gltf) => {
      const root = gltf.scene;
      // Scale by height so every unit stands just under one tile tall, whatever its cloak or weapon width.
      const height = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).y || 1;
      const scale = UNIT_HEIGHT / height;
      root.scale.setScalar(scale);
      root.updateMatrixWorld(true);
      // Stand the model on the tile: centred models and feet-origin rigs both land with their soles at the tile top.
      const lift = 0.045 - new THREE.Box3().setFromObject(root).min.y;
      toonify(root, 0.012 / scale, unitRamp, UNIT_GLOW);
      root.name = "unit-glb";
      return { root, lift, clips: clipMap(gltf.animations) };
    }).catch((error) => {
      templates.delete(url);
      throw error;
    });
    templates.set(url, pending);
  }
  return pending;
}

// Generated terrain: floor tile and rubble, approved in the asset studio under assets/board/.
const TERRAIN = {
  tile: "/assets/board/tile/tile.approved.glb",
  rubble: "/assets/board/rubble/rubble.approved.glb",
};
const TILE_FOOT = 0.96;
const TILE_TOP = 0.04;
const terrainRamp = toonRamp([140, 200, 255]);
const terrainTemplates = new Map();

// Load a terrain piece and bake it to one square of the grid: footprint TILE_FOOT, origin at the bottom centre.
function loadTerrain(url) {
  let pending = terrainTemplates.get(url);
  if (!pending) {
    pending = loader.loadAsync(url).then((gltf) => {
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = TILE_FOOT / Math.max(size.x, size.z, 1e-6);
      const parts = [];
      root.traverse((child) => {
        if (!child.isMesh) return;
        const geometry = child.geometry.clone().applyMatrix4(child.matrixWorld);
        geometry.translate(-center.x, -box.min.y, -center.z);
        geometry.scale(scale, scale, scale);
        const source = Array.isArray(child.material) ? child.material[0] : child.material;
        parts.push({ geometry, map: source.map || null, color: source.color ? source.color.clone() : new THREE.Color("#ffffff") });
      });
      return { parts, height: size.y * scale };
    }).catch((error) => {
      terrainTemplates.delete(url);
      throw error;
    });
    terrainTemplates.set(url, pending);
  }
  return pending;
}

// A stable quarter turn per tile, so the floor's cracks do not repeat in rows.
function quarterTurn(col, row) {
  return (((col * 73856093) ^ (row * 19349663)) >>> 0) % 4;
}

function findFighter(fighters, side, index) {
  return fighters.find((item) => item.side === side && item.index === index);
}

function planarDir(from, to) {
  const x = to.x - from.x;
  const z = to.z - from.z;
  const length = Math.hypot(x, z);
  if (length < 1e-4) return { x: 0, z: 1 };
  return { x: x / length, z: z / length };
}

export function stepTrace(fighters, line) {
  const step = parseTraceLine(line);
  const actor = step.actor ? findFighter(fighters, step.actor.side, step.actor.index) : null;
  if (step.kind === "move" && actor) {
    actor.group.position.set(step.to.col, 0, step.to.row);
    actor.group.scale.setScalar(1);
  }
  if (step.kind === "cast" && Number.isFinite(step.to.col)) {
    const target = findFighter(fighters, step.target.side, step.target.index);
    if (target) {
      target.group.position.set(step.to.col, 0, step.to.row);
      if (step.rounds > 0) setStatus(target, step.effect, true);
    }
  }
  if (step.kind === "expire" && actor) setStatus(actor, step.effect, false);
  if (step.kind === "defend" && actor) actor.group.scale.setScalar(1.12);
  if (step.kind === "death" && actor) {
    actor.group.visible = false;
    clearStatuses(actor);
  }
}

// A world-space planar direction expressed in the fighter's own (rotated) frame.
function localDir(fighter, dir) {
  const a = -fighter.group.rotation.y;
  return { x: dir.x * Math.cos(a) + dir.z * Math.sin(a), z: -dir.x * Math.sin(a) + dir.z * Math.cos(a) };
}

function captureRest(mesh) {
  const nodes = [];
  mesh.traverse((obj) => {
    nodes.push({
      obj,
      position: obj.position.clone(),
      quaternion: obj.quaternion.clone(),
      scale: obj.scale.clone(),
    });
  });
  const root = nodes[0];
  return {
    nodes,
    pose: {
      position: root.position.clone(),
      euler: new THREE.Euler().setFromQuaternion(root.quaternion, root.obj.rotation.order),
      scale: root.scale.clone(),
    },
  };
}

function restMesh(fighter) {
  if (fighter.clips && fighter.clips.idle && fighter.mixer && fighter.mesh) {
    // Rigged units breathe: return to the idle loop at its natural speed.
    if (fighter.activeClip !== "idle") {
      const action = fighter.mixer.clipAction(fighter.clips.idle);
      action.reset().setLoop(THREE.LoopRepeat, Infinity);
      action.timeScale = 1;
      action.time = Math.random() * fighter.clips.idle.duration;
      fadeTo(fighter, action);
      fighter.activeClip = "idle";
    }
    return;
  }
  fighter.activeClip = "";
  if (fighter.mixer) fighter.mixer.stopAllAction();
  if (!fighter.rest) return;
  for (const node of fighter.rest.nodes) {
    node.obj.position.copy(node.position);
    node.obj.quaternion.copy(node.quaternion);
    node.obj.scale.copy(node.scale);
  }
}

function poseRoot(fighter, position, euler, scale) {
  const mesh = fighter.mesh;
  if (!mesh) return;
  mesh.position.set(position.x, position.y, position.z);
  mesh.rotation.set(euler.x, euler.y, euler.z);
  mesh.scale.set(scale.x, scale.y, scale.z);
}

const FADE = 0.12;
const MAX_CLIP_SPEED = 3;

// Cross-fade from whatever the fighter is doing to `action`.
function fadeTo(fighter, action) {
  const previous = fighter.currentAction;
  action.enabled = true;
  action.setEffectiveWeight(1);
  action.play();
  if (previous && previous !== action) action.crossFadeFrom(previous, FADE, false);
  fighter.currentAction = action;
}

function playClip(fighter, name, loop, durationMs) {
  const clip = fighter.clips && fighter.clips[name];
  if (!clip || !fighter.mixer || !fighter.mesh) return false;
  if (fighter.activeClip !== name) {
    const action = fighter.mixer.clipAction(clip);
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    const seconds = Math.max(0.05, durationMs / 1000);
    if (loop) {
      // A run cycle keeps its stride: about two cycles per step, never faster than the cap.
      action.timeScale = Math.min(MAX_CLIP_SPEED, Math.max(0.5, (clip.duration * 2) / seconds));
    } else {
      // A long one-shot plays its middle stretch at no more than MAX_CLIP_SPEED, so it reads as motion.
      const speed = Math.min(MAX_CLIP_SPEED, Math.max(1, clip.duration / seconds));
      action.timeScale = speed;
      action.time = Math.max(0, (clip.duration - seconds * speed) / 2);
    }
    fadeTo(fighter, action);
    fighter.activeClip = name;
  }
  return true;
}

function runPose(fighter, t, dir) {
  const rest = fighter.rest && fighter.rest.pose;
  if (!rest) return;
  const envelope = Math.sin(t * Math.PI);
  const cycle = Math.sin(t * Math.PI * 6);
  poseRoot(
    fighter,
    {
      x: rest.position.x + dir.x * cycle * 0.1,
      y: rest.position.y + envelope * 0.18,
      z: rest.position.z + dir.z * cycle * 0.1,
    },
    {
      x: rest.euler.x + envelope * 0.18,
      y: rest.euler.y,
      z: rest.euler.z + cycle * 0.42,
    },
    rest.scale,
  );
}

function attackPose(fighter, t, dir) {
  const rest = fighter.rest && fighter.rest.pose;
  if (!rest) return;
  const lunge = Math.sin(t * Math.PI);
  poseRoot(
    fighter,
    {
      x: rest.position.x + dir.x * lunge * 0.48,
      y: rest.position.y + lunge * 0.05,
      z: rest.position.z + dir.z * lunge * 0.48,
    },
    { x: rest.euler.x + lunge * 0.65, y: rest.euler.y, z: rest.euler.z },
    rest.scale,
  );
}

function castPose(fighter, t) {
  const rest = fighter.rest && fighter.rest.pose;
  if (!rest) return;
  const pulse = Math.sin(t * Math.PI);
  poseRoot(
    fighter,
    { x: rest.position.x, y: rest.position.y + pulse * 0.36, z: rest.position.z },
    { x: rest.euler.x - pulse * 0.5, y: rest.euler.y, z: rest.euler.z },
    {
      x: rest.scale.x * (1 - pulse * 0.08),
      y: rest.scale.y * (1 + pulse * 0.28),
      z: rest.scale.z * (1 - pulse * 0.08),
    },
  );
}

function hitWeight(t) {
  if (t < HIT_AT) return 0;
  const u = (t - HIT_AT) / (1 - HIT_AT);
  return Math.sin(Math.min(1, u) * Math.PI);
}

function hitPose(fighter, t, dir) {
  const rest = fighter.rest && fighter.rest.pose;
  if (!rest) return;
  const flinch = hitWeight(t);
  poseRoot(
    fighter,
    {
      x: rest.position.x + dir.x * flinch * 0.32,
      y: rest.position.y,
      z: rest.position.z + dir.z * flinch * 0.32,
    },
    { x: rest.euler.x + flinch * 0.35, y: rest.euler.y, z: rest.euler.z + flinch * 0.85 },
    rest.scale,
  );
}

function sinkPose(fighter, t) {
  const rest = fighter.rest && fighter.rest.pose;
  if (!rest) return;
  poseRoot(
    fighter,
    { x: rest.position.x, y: rest.position.y - t * 0.5, z: rest.position.z },
    { x: rest.euler.x + t * 0.9, y: rest.euler.y, z: rest.euler.z + t * 0.4 },
    rest.scale,
  );
}

export function createBoardView(host, options) {
  const cols = options.cols;
  const rows = options.rows;
  const mySide = options.mySide || 0;
  const lines = options.lines || [];
  const blocked = options.blocked || [];
  const onProgress = options.onProgress || (() => {});
  let playing = !!options.playing;
  let speed = Number(options.speed) || 2;
  let stepMs = Number(options.stepMs) > 0 ? Number(options.stepMs) : 0;
  let cursor = 0;
  let motion = null;
  let stopped = false;
  let lastNow = performance.now();

  const width = host.clientWidth || 360;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  host.appendChild(renderer.domElement);
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
  host.appendChild(overlay);
  const onImpact = options.onImpact || (() => {});
  const popups = [];
  const POPUP_MS = 900;
  const calm = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let shakeUntil = 0;
  let shakePower = 0;
  const cameraHome = new THREE.Vector3();
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const sun = new THREE.DirectionalLight(0xfff1dc, 1.7);
  sun.position.set(4, 10, 6);
  scene.add(sun);

  function layout() {
    const viewWidth = host.clientWidth || width;
    const viewHeight = Math.round(Math.min(520, Math.max(280, viewWidth * 0.8)));
    const aspect = viewWidth / viewHeight;
    const span = Math.max(cols, rows);
    // Fit the isometric footprint: about 0.71 * (cols + rows) wide and 0.41 * (cols + rows) tall, plus unit height.
    const halfW = Math.max((cols + rows) * 0.4, ((cols + rows) * 0.25 + 0.8) * aspect);
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfW / aspect;
    camera.bottom = -halfW / aspect;
    camera.position.set(span, span, span);
    camera.lookAt((cols - 1) / 2, 0, (rows - 1) / 2);
    cameraHome.copy(camera.position);
    camera.updateProjectionMatrix();
    renderer.setSize(viewWidth, viewHeight);
  }
  layout();
  const observer = new ResizeObserver(() => layout());
  observer.observe(host);

  const edge = new THREE.LineBasicMaterial({ color: INK });
  const blockedKey = new Set(blocked.map((tile) => `${tile.col},${tile.row}`));
  const zoneColor = (row) => {
    const side = row < ZONE_DEPTH ? 0 : row >= rows - ZONE_DEPTH ? 1 : -1;
    return side === -1 ? null : side === mySide ? ALLY_ZONE : FOE_ZONE;
  };
  // Plain boxes first; the generated meshes replace them once they load, and stay if a file is missing.
  const fallbackFloor = new THREE.Group();
  const fallbackRubble = new THREE.Group();
  scene.add(fallbackFloor, fallbackRubble);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const isBlocked = blockedKey.has(`${col},${row}`);
      const geometry = new THREE.BoxGeometry(0.92, isBlocked ? 0.22 : 0.08, 0.92);
      const tile = new THREE.Mesh(
        geometry,
        new THREE.MeshToonMaterial({ color: isBlocked ? RUBBLE : zoneColor(row) || TILE[(col + row) % 2], gradientMap: ramp }),
      );
      tile.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edge));
      tile.position.set(col, isBlocked ? 0.07 : 0, row);
      (isBlocked ? fallbackRubble : fallbackFloor).add(tile);
    }
  }

  // Tints multiply the stone texture: blue for your zone, red for the foe's, a light/dark checker between.
  const tileTint = (col, row) => {
    const side = row < ZONE_DEPTH ? 0 : row >= rows - ZONE_DEPTH ? 1 : -1;
    if (side !== -1) return side === mySide ? TINT_ALLY : TINT_FOE;
    return TINT_FLOOR[(col + row) % 2];
  };
  let floorHeight = 0.08;
  host.dataset.terrain = "loading";
  const terrainState = { tile: "loading", rubble: blocked.length ? "loading" : "none" };
  const paintTerrain = () => { host.dataset.terrain = `tile:${terrainState.tile} rubble:${terrainState.rubble}`; };
  paintTerrain();

  void loadTerrain(TERRAIN.tile).then((template) => {
    if (stopped) return;
    floorHeight = template.height;
    const spots = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) if (!blockedKey.has(`${col},${row}`)) spots.push({ col, row });
    }
    const matrix = new THREE.Matrix4();
    const turn = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    for (const part of template.parts) {
      const material = new THREE.MeshToonMaterial({ map: part.map, color: part.color, gradientMap: terrainRamp });
      const floor = new THREE.InstancedMesh(part.geometry, material, spots.length);
      const hull = new THREE.InstancedMesh(part.geometry, outlineMaterial(0.012), spots.length);
      spots.forEach((spot, i) => {
        turn.setFromAxisAngle(up, (quarterTurn(spot.col, spot.row) * Math.PI) / 2);
        matrix.compose(new THREE.Vector3(spot.col, TILE_TOP - template.height, spot.row), turn, one);
        floor.setMatrixAt(i, matrix);
        hull.setMatrixAt(i, matrix);
        floor.setColorAt(i, new THREE.Color(tileTint(spot.col, spot.row)));
      });
      floor.name = "terrain-floor";
      scene.add(floor, hull);
    }
    scene.remove(fallbackFloor);
    terrainState.tile = "glb";
    paintTerrain();
  }).catch(() => {
    terrainState.tile = "box";
    paintTerrain();
  });

  if (blocked.length) {
    void loadTerrain(TERRAIN.rubble).then((template) => {
      if (stopped) return;
      for (const tile of blocked) {
        const piece = new THREE.Group();
        for (const part of template.parts) {
          const mesh = new THREE.Mesh(part.geometry, new THREE.MeshToonMaterial({ map: part.map, color: part.color, gradientMap: terrainRamp }));
          mesh.add(new THREE.Mesh(part.geometry, outlineMaterial(0.012)));
          piece.add(mesh);
        }
        // Rubble stands on the same ground as the floor tiles around it.
        piece.position.set(tile.col, TILE_TOP - floorHeight, tile.row);
        piece.rotation.y = (quarterTurn(tile.col, tile.row) * Math.PI) / 2;
        piece.name = "terrain-rubble";
        scene.add(piece);
      }
      scene.remove(fallbackRubble);
      terrainState.rubble = "glb";
      paintTerrain();
    }).catch(() => {
      terrainState.rubble = "box";
      paintTerrain();
    });
  }

  const fighters = [];

  function poseLabel(fighter) {
    if (!motion) return "rest";
    if (motion.move && motion.move.fighter === fighter) return "run";
    if (motion.strike && motion.strike.fighter === fighter) return motion.strike.kind;
    if (motion.hit && motion.hit.fighter === fighter && hitWeight(motionT()) > 0) return "hit";
    if (motion.sink && motion.sink.fighter === fighter) return "sink";
    return "rest";
  }

  function paintDatasets() {
    host.dataset.unitModels = fighters.map((fighter) => `${fighter.side}:${fighter.index}:${fighter.kind}:${fighter.model}`).join(" ");
    host.dataset.unitClips = fighters.map((fighter) => `${fighter.side}:${fighter.index}:${fighter.activeClip || "-"}`).join(" ");
    host.dataset.unitStatuses = fighters
      .filter((fighter) => fighter.statuses?.size)
      .map((fighter) => `${fighter.side}:${fighter.index}:${[...fighter.statuses.keys()].join(",")}`)
      .join(" ");
    host.dataset.unitPositions = fighters.map((fighter) => `${fighter.side}:${fighter.index}:${fighter.group.position.x},${fighter.group.position.z}`).join(" ");
    host.dataset.unitPose = fighters.map((fighter) => {
      const mesh = fighter.mesh;
      if (!mesh) return `${fighter.side}:${fighter.index}:loading`;
      const p = mesh.position;
      const r = mesh.rotation;
      return `${fighter.side}:${fighter.index}:${poseLabel(fighter)}:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}:${r.x.toFixed(3)},${r.y.toFixed(3)},${r.z.toFixed(3)}:${mesh.scale.y.toFixed(3)}`;
    }).join(" ");
  }

  function place(side, index, unit) {
    const spot = deploy(side, rows, unit);
    const group = new THREE.Group();
    const marker = ring(side === mySide ? ALLY : FOE);
    marker.position.y = 0.045;
    group.add(marker);
    group.position.set(spot.col, 0, spot.row);
    // Models face +Z. Side A deploys on low rows and faces the foe as is; side B turns around.
    const facing = side === 0 ? 0 : Math.PI;
    group.rotation.y = facing;
    scene.add(group);
    const fighter = {
      side,
      index,
      kind: unit.kind,
      model: "loading",
      home: spot,
      facing: side === 0 ? 0 : Math.PI,
      group,
      mesh: null,
      rest: null,
      clips: null,
      mixer: null,
      activeClip: "",
    };
    fighters.push(fighter);
    const url = unitMeshUrl(unit.race || 0, unit.kind);
    const color = unitColor(unit.race || 0, unit.kind);
    void attachMesh(fighter, url, color);
  }

  function bindMesh(fighter, mesh, clips) {
    // Clones share materials with their template; give each fighter its own so a hit flash stays on that unit.
    fighter.flashMaterials = [];
    mesh.traverse((child) => {
      if (!child.isMesh || child.material?.side === THREE.BackSide) return;
      const own = (material) => {
        const copy = material.clone();
        if (copy.emissive) {
          copy.userData.baseEmissive = copy.emissive.clone();
          fighter.flashMaterials.push(copy);
        }
        return copy;
      };
      child.material = Array.isArray(child.material) ? child.material.map(own) : own(child.material);
    });
    fighter.mesh = mesh;
    fighter.rest = captureRest(mesh);
    fighter.clips = clips;
    fighter.model = mesh.name === "unit-glb" ? "glb" : "box";
    if (clips && Object.keys(clips).length) {
      fighter.mixer = new THREE.AnimationMixer(mesh);
    }
    fighter.group.add(mesh);
    restMesh(fighter);
    if (motion) applyMotion(motion, motionT());
  }

  async function attachMesh(fighter, url, color) {
    let mesh = null;
    let clips = null;
    if (url) {
      try {
        const template = await loadTemplate(url);
        mesh = cloneModel(template.root);
        mesh.position.y = template.lift;
        mesh.name = "unit-glb";
        clips = template.clips;
      } catch {
        mesh = null;
      }
    }
    if (stopped) return;
    if (!mesh) mesh = placeholderMesh(color);
    bindMesh(fighter, mesh, clips);
    paintDatasets();
  }

  (options.unitsA || []).forEach((unit, index) => place(0, index, unit));
  (options.unitsB || []).forEach((unit, index) => place(1, index, unit));
  paintDatasets();

  function resetFighters() {
    for (const fighter of fighters) {
      fighter.group.position.set(fighter.home.col, 0, fighter.home.row);
      fighter.group.rotation.y = fighter.facing;
      fighter.group.scale.setScalar(1);
      fighter.group.visible = true;
      clearStatuses(fighter);
      restMesh(fighter);
    }
  }

  function screenPoint(fighter) {
    const point = fighter.group.position.clone();
    point.y += 1.15;
    point.project(camera);
    const canvas = renderer.domElement;
    return {
      x: ((point.x + 1) / 2) * canvas.clientWidth + canvas.offsetLeft,
      y: ((1 - point.y) / 2) * canvas.clientHeight + canvas.offsetTop,
    };
  }

  // A number or word that pops above a fighter and floats away.
  function popup(fighter, text, tone) {
    const at = screenPoint(fighter);
    const colors = { ally: "#ff7a72", foe: "#ffcb45", calm: "#fff4dc", heal: "#8fe39a", boon: "#9fd3ff" };
    const label = document.createElement("span");
    label.textContent = text;
    label.dataset.popup = tone;
    label.style.cssText = [
      "position:absolute",
      `left:${at.x}px`,
      `top:${at.y}px`,
      "transform:translate(-50%,-30%) scale(0.6)",
      "opacity:0",
      `color:${colors[tone] || colors.calm}`,
      "font:700 " + (tone === "calm" ? "16px" : tone === "boon" ? "20px" : "28px") + " 'Grenze Gotisch', Georgia, serif",
      "paint-order:stroke fill",
      "-webkit-text-stroke:5px #0e0a08",
      "text-shadow:0 3px 0 #0e0a08",
      "white-space:nowrap",
    ].join(";");
    overlay.appendChild(label);
    popups.push({ label, born: performance.now() });
  }

  // Popups run on the board's own clock: pop in, rise, fade over POPUP_MS.
  function stepPopups(now) {
    for (let i = popups.length - 1; i >= 0; i -= 1) {
      const item = popups[i];
      const t = (now - item.born) / POPUP_MS;
      if (t >= 1) {
        item.label.remove();
        popups.splice(i, 1);
        continue;
      }
      const rise = 1 - (1 - t) * (1 - t);
      const scale = t < 0.18 ? 0.6 + (t / 0.18) * 0.55 : Math.max(0.95, 1.15 - (t - 0.18) * 0.4);
      const opacity = t < 0.15 ? t / 0.15 : t > 0.7 ? (1 - t) / 0.3 : 1;
      item.label.style.transform = `translate(-50%, ${-30 - rise * 130}%) scale(${scale.toFixed(3)})`;
      item.label.style.opacity = opacity.toFixed(3);
    }
  }

  function flash(fighter) {
    fighter.flashUntil = performance.now() + 140;
    for (const material of fighter.flashMaterials || []) material.emissive.setRGB(1, 1, 1);
  }

  function shake(power) {
    if (calm) return;
    shakePower = Math.max(shakePower, power);
    shakeUntil = performance.now() + 260;
  }

  function settleEffects(now) {
    for (const fighter of fighters) {
      if (fighter.flashUntil && now >= fighter.flashUntil) {
        fighter.flashUntil = 0;
        for (const material of fighter.flashMaterials || []) material.emissive.copy(material.userData.baseEmissive || new THREE.Color(0, 0, 0));
      }
    }
    if (now < shakeUntil) {
      const fade = (shakeUntil - now) / 260;
      camera.position.set(
        cameraHome.x + (Math.random() - 0.5) * shakePower * fade,
        cameraHome.y + (Math.random() - 0.5) * shakePower * fade,
        cameraHome.z + (Math.random() - 0.5) * shakePower * fade,
      );
    } else if (shakePower) {
      shakePower = 0;
      camera.position.copy(cameraHome);
    }
  }

  // The moment a trace line lands: numbers, flash, shake, and a callback for sound.
  function impact(current) {
    if (current.seek || current.impacted) return;
    current.impacted = true;
    const { step } = current;
    const actor = step.actor ? findFighter(fighters, step.actor.side, step.actor.index) : null;
    const hits = step.kind === "attack" || step.kind === "cast";
    if (hits && current.hit === null) {
      const target = findFighter(fighters, step.target.side, step.target.index);
      const note = step.kind === "cast" ? castNote(step) : null;
      if (target) popup(target, note ? note.text : "0", note ? note.tone : "calm");
      onImpact({ kind: step.kind === "attack" ? "miss" : "cast", line: current.line });
      return;
    }
    if (step.kind === "expire" && actor) {
      popup(actor, `${STATUS_AURAS[step.effect]?.label || "Effect"} fades`, "calm");
      return;
    }
    if (current.hit) {
      const victim = current.hit.fighter;
      popup(victim, `-${step.damage}`, victim.side === mySide ? "ally" : "foe");
      flash(victim);
      if (step.damage >= 3) shake(0.12);
      onImpact({ kind: step.kind === "attack" ? "hit" : "cast", damage: step.damage, mine: victim.side === mySide, line: current.line });
    }
    if (step.kind === "defend" && actor) {
      popup(actor, "Defend", "calm");
      onImpact({ kind: "defend", line: current.line });
    }
    if (step.kind === "death" && actor) {
      shake(0.22);
      onImpact({ kind: "death", mine: actor.side === mySide, line: current.line });
    }
  }

  // What a cast that dealt no damage did, as a popup over its target.
  function castNote(step) {
    switch (step.effect) {
      case "heal":
        return step.amount > 0 ? { text: `+${step.amount}`, tone: "heal" } : null;
      case "sprint":
        return { text: "Sprint", tone: "boon" };
      case "reach":
        return { text: `+${step.amount} reach`, tone: "boon" };
      case "taunt":
        return { text: "Taunted", tone: "foe" };
      case "push":
        return step.amount > 0 ? { text: "Pushed", tone: "calm" } : null;
      default:
        return null;
    }
  }

  function publish() {
    paintDatasets();
    onProgress(cursor);
  }

  // How long a trace line takes to play, by kind. Strikes and deaths get time for their clip.
  const STEP_MS = { move: 320, attack: 700, cast: 760, defend: 420, death: 760, expire: 360 };
  const SPEED_FACTOR = { 1: 1.45, 2: 1, 3: 0.55 };
  function delay(step) {
    if (stepMs > 0) return stepMs;
    return (STEP_MS[step.kind] || 200) * (SPEED_FACTOR[speed] || 1);
  }

  function motionT() {
    if (!motion) return 0;
    return Math.min(1, motion.elapsed / Math.max(1, motion.duration));
  }

  function beginMotion(line, seek) {
    const step = parseTraceLine(line);
    const actor = step.actor ? findFighter(fighters, step.actor.side, step.actor.index) : null;
    const next = {
      line,
      step,
      seek,
      duration: Math.max(1, delay(step)),
      elapsed: 0,
      move: null,
      strike: null,
      hit: null,
      shove: null,
      sink: null,
      guard: null,
    };
    if (step.kind === "move" && actor) {
      const traceFrom = new THREE.Vector3(step.from.col, 0, step.from.row);
      const to = new THREE.Vector3(step.to.col, 0, step.to.row);
      const from = actor.group.position.clone();
      next.move = { fighter: actor, from, to, dir: planarDir(seek ? traceFrom : from, to) };
      actor.group.rotation.y = Math.atan2(next.move.dir.x, next.move.dir.z);
      if (!seek) actor.group.scale.setScalar(1);
    }
    if ((step.kind === "attack" || step.kind === "cast") && actor) {
      const target = findFighter(fighters, step.target.side, step.target.index);
      const origin = actor.group.position.clone();
      const aim = target ? target.group.position.clone() : origin.clone().add(new THREE.Vector3(0, 0, 1));
      const strikeDir = planarDir(origin, aim);
      if (target && target !== actor) actor.group.rotation.y = Math.atan2(strikeDir.x, strikeDir.z);
      next.strike = { fighter: actor, dir: strikeDir, kind: step.kind };
      if (target && step.damage > 0) {
        next.hit = { fighter: target, dir: planarDir(origin, target.group.position) };
      }
      if (!seek && step.kind === "cast" && target && Number.isFinite(step.to.col)) {
        next.shove = {
          fighter: target,
          from: target.group.position.clone(),
          to: new THREE.Vector3(step.to.col, 0, step.to.row),
        };
      }
    }
    if (!seek && step.kind === "defend" && actor) {
      actor.group.scale.setScalar(1.12);
      if (actor.clips && actor.clips.defend) next.guard = { fighter: actor };
    }
    if (step.kind === "death" && actor && actor.group.visible) next.sink = { fighter: actor };
    if (seek && !next.move && !next.strike && !next.hit && !next.sink) return null;
    return next;
  }

  function applyMotion(current, t) {
    const lands = current.hit || current.strike ? t >= HIT_AT : true;
    if (lands && !current.move) impact(current);
    if (current.move) {
      if (!current.seek) {
        const posed = current.move.from.clone().lerp(current.move.to, t);
        current.move.fighter.group.position.set(posed.x, 0, posed.z);
      }
      if (!playClip(current.move.fighter, "run", true, current.duration)) {
        runPose(current.move.fighter, t, localDir(current.move.fighter, current.move.dir));
      }
    }
    if (current.shove) {
      const posed = current.shove.from.clone().lerp(current.shove.to, t);
      current.shove.fighter.group.position.set(posed.x, 0, posed.z);
    }
    if (current.strike) {
      const clipName = current.strike.kind === "attack" ? "attack" : "cast";
      if (!playClip(current.strike.fighter, clipName, false, current.duration)) {
        if (current.strike.kind === "attack") attackPose(current.strike.fighter, t, localDir(current.strike.fighter, current.strike.dir));
        else castPose(current.strike.fighter, t);
      }
    }
    if (current.hit && t >= HIT_AT) {
      const windowMs = current.duration * (1 - HIT_AT);
      if (!playClip(current.hit.fighter, "hit", false, windowMs)) {
        hitPose(current.hit.fighter, t, localDir(current.hit.fighter, current.hit.dir));
      }
    }
    if (current.sink && !playClip(current.sink.fighter, "death", false, current.duration)) sinkPose(current.sink.fighter, t);
    if (current.guard) playClip(current.guard.fighter, "defend", false, current.duration);
  }

  function restActors(current) {
    const list = [current.move, current.strike, current.hit, current.sink, current.guard];
    const seen = new Set();
    for (const item of list) {
      if (!item || seen.has(item.fighter)) continue;
      seen.add(item.fighter);
      restMesh(item.fighter);
    }
  }

  function finishMotion(current) {
    restActors(current);
    if (current.seek) return;
    stepTrace(fighters, current.line);
    cursor += 1;
    publish();
  }

  function seek(next) {
    cursor = Math.max(0, Math.min(lines.length, next));
    motion = null;
    resetFighters();
    for (let index = 0; index < cursor; index += 1) stepTrace(fighters, lines[index]);
    for (const fighter of fighters) restMesh(fighter);
    if (cursor > 0) {
      motion = beginMotion(lines[cursor - 1], true);
      if (motion) motion.mark = performance.now();
    }
    publish();
  }

  function stepMixers(dt) {
    if (dt <= 0) return;
    for (const fighter of fighters) {
      if (fighter.mixer && fighter.activeClip && fighter.group.visible) fighter.mixer.update(dt);
    }
  }

  function syncMotionClock() {
    if (!motion) return;
    const running = motion.seek || playing;
    if (!running) {
      motion.mark = 0;
      return;
    }
    if (!motion.mark) motion.mark = performance.now() - motion.elapsed;
    const elapsed = performance.now() - motion.mark;
    const prev = motion.elapsed;
    // A late frame would skip the pose. Hold the stride peak for that frame, then continue.
    const mid = motion.duration * 0.42;
    if (!motion.shownMid && prev < motion.duration * 0.35 && elapsed > motion.duration * 0.65) {
      motion.elapsed = mid;
      motion.shownMid = true;
      motion.mark = performance.now() - mid;
      return;
    }
    motion.elapsed = elapsed;
    if (elapsed >= motion.duration * 0.35) motion.shownMid = true;
  }

  publish();
  let frameId = 0;
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - lastNow) / 1000));
    lastNow = now;
    try {
      syncMotionClock();
      let held = false;
      if (motion && motion.elapsed >= motion.duration) {
        const finished = motion;
        motion = null;
        finishMotion(finished);
        held = true;
      }
      if (!held && !motion && playing && cursor < lines.length) {
        const started = beginMotion(lines[cursor], false);
        if (started) {
          started.mark = performance.now();
          motion = started;
        } else {
          stepTrace(fighters, lines[cursor]);
          cursor += 1;
          publish();
        }
      }
      if (motion) applyMotion(motion, motionT());
      // Idle loops keep breathing while paused; one-shot clips advance only while the step plays.
      stepMixers(motion && !(motion.seek || playing) ? 0 : dt);
      settleEffects(now);
      stepPopups(now);
      paintDatasets();
      renderer.render(scene, camera);
    } catch (error) {
      host.dataset.boardError = String(error && error.stack ? error.stack : error);
    } finally {
      if (!stopped) frameId = window.requestAnimationFrame(frame);
    }
  }
  frameId = window.requestAnimationFrame(frame);

  return {
    setPlaying(next) {
      playing = !!next;
      if (playing) lastNow = performance.now();
    },
    setSpeed(next) {
      speed = Number(next) || 1;
    },
    setStepMs(next) {
      stepMs = Number(next) > 0 ? Number(next) : 0;
    },
    seek,
    dispose() {
      stopped = true;
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
      overlay.remove();
      delete host.dataset.unitModels;
      delete host.dataset.unitPositions;
      delete host.dataset.unitClips;
      delete host.dataset.terrain;
      delete host.dataset.unitPose;
      delete host.dataset.boardError;
    },
  };
}
