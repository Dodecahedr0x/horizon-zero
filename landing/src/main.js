import catalog from "../../content/catalog.json";

// VITE_WEB_ORIGIN is the public game web service (scheme + host). Render cannot
// inject that URL via fromService: host is the private-network name, and static
// sites are not on that network. Unset in production means same-origin, which
// is only right if the page is served by the game itself. Dev defaults to the
// Node server that serves /assets.
const configured = import.meta.env.VITE_WEB_ORIGIN;
const origin = (typeof configured === "string" && configured.trim()
  ? configured.trim()
  : import.meta.env.DEV
    ? "http://127.0.0.1:4715"
    : ""
).replace(/\/$/, "");

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function assetUrl(path) {
  return `${origin}/assets/${path}`;
}

function artCandidates(path) {
  const raced = String(path).match(/^units\/([^/]+)\/([^/]+)\/\2\.approved\.(png|glb)$/);
  if (raced) return [path, `units/${raced[2]}/${raced[2]}.approved.${raced[3]}`];
  const plain = String(path).match(/^units\/([^/]+)\/\1\.approved\.(png|glb)$/);
  if (plain) return [`units/ashborn/${plain[1]}/${plain[1]}.approved.${plain[2]}`, path];
  return [path];
}

for (const link of document.querySelectorAll("[data-play]")) {
  link.href = origin ? `${origin}/` : "/";
}

// One request per approved file, shared by every <img> and canvas that draws it.
const images = new Map();

function loadImage(path) {
  if (!images.has(path)) {
    images.set(path, new Promise((resolve) => {
      const paths = artCandidates(path);
      let index = 0;
      const img = new Image();
      img.decoding = "async";
      const next = () => {
        if (index >= paths.length) return resolve(null);
        img.src = assetUrl(paths[index]);
        index += 1;
      };
      img.addEventListener("error", next);
      img.addEventListener("load", () => resolve(img));
      next();
    }));
  }
  return images.get(path);
}

async function mountImage(frame) {
  const path = frame.getAttribute("data-asset");
  if (!path || frame.dataset.state) return;
  frame.dataset.state = "pending";
  const source = await loadImage(path);
  if (!source) {
    frame.dataset.state = "fallback";
    return;
  }
  const img = document.createElement("img");
  img.src = source.src;
  img.alt = frame.getAttribute("data-alt") || "";
  img.decoding = "async";
  frame.appendChild(img);
  await img.decode().catch(() => {});
  frame.dataset.state = "ready";
}

const unitPath = (unit) => `units/${unit.race}/${unit.slug}/${unit.slug}.approved.png`;
const TILE = "board/tile/tile.approved.png";
const RUBBLE = "board/rubble/rubble.approved.png";

// ---------------------------------------------------------------- hero sky

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A ridge line from summed sine octaves with seeded phases, closed to the bottom.
function ridgePath(seed, base, amp, jag) {
  const rand = seeded(seed);
  const octaves = [1, 2.3, 5.1, 11.7, 23].map((f, i) => ({ f, p: rand() * Math.PI * 2, a: 1 / (i + 1) ** jag }));
  const total = octaves.reduce((sum, o) => sum + o.a, 0);
  let d = "M0 400";
  for (let x = 0; x <= 1600; x += 8) {
    const u = x / 1600;
    let y = 0;
    for (const o of octaves) y += Math.sin(u * o.f * Math.PI * 2 + o.p) * o.a;
    d += ` L${x} ${(base - (y / total) * amp).toFixed(1)}`;
  }
  return `${d} L1600 400 Z`;
}

const ridges = { far: [7, 170, 70, 1.1], mid: [19, 235, 80, 1.3], near: [31, 320, 46, 1.6] };
for (const path of document.querySelectorAll("[data-ridge]")) {
  const args = ridges[path.getAttribute("data-ridge")];
  if (args) path.setAttribute("d", ridgePath(...args));
}

const hero = document.querySelector(".hero");
const layers = [...document.querySelectorAll(".sky [data-depth]")];
const bar = document.querySelector(".bar");
let scrollQueued = false;

function onScroll() {
  scrollQueued = false;
  const y = window.scrollY;
  bar.classList.toggle("solid", y > 24);
  if (reduceMotion || y > hero.offsetHeight) return;
  for (const layer of layers) {
    layer.style.translate = `0 ${(y * Number(layer.dataset.depth)).toFixed(1)}px`;
  }
  hero.style.setProperty("--fade", Math.min(1, y / (hero.offsetHeight * 0.7)).toFixed(3));
}

window.addEventListener("scroll", () => {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(onScroll);
}, { passive: true });
onScroll();

for (const frame of document.querySelectorAll("[data-eager]")) void mountImage(frame);

// Rising embers. Additive dots with a short tail, paused when the hero is off screen.
function embers(canvas) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rand = Math.random;
  let width = 0;
  let height = 0;
  let sparks = [];
  let running = false;
  let last = 0;

  const spawn = (anywhere) => ({
    x: rand() * width,
    y: anywhere ? rand() * height : height + 10,
    r: 0.6 + rand() * 1.8,
    vy: 18 + rand() * 46,
    sway: 10 + rand() * 30,
    phase: rand() * Math.PI * 2,
    life: 0,
    heat: rand(),
  });

  const resize = () => {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.round(Math.min(110, width / 12));
    sparks = Array.from({ length: count }, () => spawn(true));
  };

  const draw = (dt) => {
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = "lighter";
    for (const s of sparks) {
      s.life += dt;
      s.y -= s.vy * dt;
      const x = s.x + Math.sin(s.life * 0.9 + s.phase) * s.sway;
      if (s.y < -20) Object.assign(s, spawn(false));
      const fade = Math.min(1, s.y / (height * 0.5));
      const flicker = 0.6 + 0.4 * Math.sin(s.life * 7 + s.phase);
      const alpha = Math.max(0, fade * flicker);
      const glow = ctx.createRadialGradient(x, s.y, 0, x, s.y, s.r * 5);
      const hue = s.heat > 0.8 ? "255,214,150" : "236,118,52";
      glow.addColorStop(0, `rgba(${hue},${alpha})`);
      glow.addColorStop(1, `rgba(${hue},0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, s.y, s.r * 5, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const frame = (now) => {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    draw(dt);
    requestAnimationFrame(frame);
  };

  resize();
  window.addEventListener("resize", resize);
  if (reduceMotion) {
    draw(0);
    return;
  }
  new IntersectionObserver(([entry]) => {
    const visible = entry.isIntersecting;
    if (visible && !running) {
      running = true;
      last = performance.now();
      requestAnimationFrame(frame);
    }
    running = visible;
  }).observe(canvas);
}

embers(document.querySelector(".embers"));

// ---------------------------------------------------------------- the match

const rite = document.querySelector(".match");
new IntersectionObserver(([entry], observer) => {
  if (!entry.isIntersecting) return;
  rite.classList.add("lit");
  observer.disconnect();
}, { threshold: 0.35 }).observe(rite);

// ---------------------------------------------------------------- the field

// Every catalog race with its units; `key` names a unit's art across races.
const races = catalog.races.map((race) => ({
  ...race,
  units: race.units.map((unit) => ({ ...unit, slug: unit.name.toLowerCase(), race: race.slug, key: `${race.slug}/${unit.name.toLowerCase()}` })),
}));
const allUnits = races.flatMap((race) => race.units);
const ZONE_DEPTH = 2;
const MAX_UNITS = 10;

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function compareBytes(a, b) {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// battle.md "Blocked tiles": candidates in rows 2..rows-2, sorted by SHA-256(seed || [col, row]),
// then row, then column; each is kept only while (0, 0) still reaches zone B.
async function blockedTiles(cols, rows, seed) {
  const candidates = [];
  for (let row = ZONE_DEPTH; row < rows - ZONE_DEPTH; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const input = new Uint8Array(seed.length + 2);
      input.set(seed);
      input[seed.length] = col;
      input[seed.length + 1] = row;
      candidates.push({ col, row, key: new Uint8Array(await crypto.subtle.digest("SHA-256", input)) });
    }
  }
  candidates.sort((a, b) => compareBytes(a.key, b.key) || a.row - b.row || a.col - b.col);
  const limit = Math.floor((cols * (rows - 2 * ZONE_DEPTH)) / 5);
  const blocked = new Set();
  const id = (col, row) => row * cols + col;
  const connected = () => {
    const seen = new Set([id(0, 0)]);
    const queue = [[0, 0]];
    while (queue.length) {
      const [col, row] = queue.pop();
      if (row >= rows - ZONE_DEPTH) return true;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        const key = id(c, r);
        if (seen.has(key) || blocked.has(key)) continue;
        seen.add(key);
        queue.push([c, r]);
      }
    }
    return false;
  };
  const order = [];
  for (const { col, row } of candidates) {
    if (order.length >= limit) break;
    const key = id(col, row);
    blocked.add(key);
    if (connected()) order.push({ col, row });
    else blocked.delete(key);
  }
  return order;
}

// A sample army of one race: walk its units in a shuffled order, keep what the budget still affords.
function sampleArmy(budget, race) {
  const preference = [...race.units].sort(() => Math.random() - 0.5);
  const army = [];
  let left = budget;
  for (let pass = 0; pass < 3 && army.length < MAX_UNITS; pass += 1) {
    for (const unit of preference) {
      if (unit.cost > left || army.length >= MAX_UNITS) continue;
      army.push(unit);
      left -= unit.cost;
    }
  }
  return army;
}

function placeArmy(army, cols, rows, side) {
  const front = side === "b" ? rows - ZONE_DEPTH : ZONE_DEPTH - 1;
  const back = side === "b" ? rows - 1 : 0;
  // Spread across the columns; melee on the front row, ranged behind it.
  return army.map((unit, i) => ({
    unit,
    col: Math.floor(((i + 0.5) * cols) / army.length),
    row: unit.range > 1 ? back : front,
    side,
  }));
}

// Top face of the approved tile art, as fractions of the image width.
const FACE = { cx: 0.5, cy: 0.42, hw: 0.465, hh: 0.3 };

function board(canvas) {
  const ctx = canvas.getContext("2d");
  const tabs = document.querySelector(".grounds");
  const roll = document.querySelector(".roll");
  const seedOut = document.querySelector("[data-seed]");
  const facts = Object.fromEntries([...document.querySelectorAll("[data-fact]")].map((el) => [el.dataset.fact, el]));
  const art = { tile: null, rubble: null, units: {} };
  let ground = catalog.battlegrounds[0];
  let state = null;
  let started = 0;
  let running = false;
  let visible = false;
  let size = { w: 0, h: 0, dpr: 1 };

  for (const bg of catalog.battlegrounds) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.role = "tab";
    tab.textContent = bg.name;
    tab.dataset.slug = bg.slug;
    tab.addEventListener("click", () => select(bg));
    tabs.appendChild(tab);
  }

  tabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const list = catalog.battlegrounds;
    const index = list.indexOf(ground) + (event.key === "ArrowRight" ? 1 : -1);
    const next = list[(index + list.length) % list.length];
    select(next);
    tabs.querySelector(`[data-slug="${next.slug}"]`).focus();
  });

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    size = { w, h, dpr };
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    paint(performance.now());
  };

  function layout() {
    const { cols, rows } = ground;
    const span = cols + rows;
    // The board plus a unit's height above the back corner and a tile's depth below the front.
    const tileW = Math.min(size.w / (span * FACE.hw + 0.2), size.h / (span * FACE.hh + 1.7));
    const hw = tileW * FACE.hw;
    const hh = tileW * FACE.hh;
    const ox = size.w / 2 - ((cols - 1) - (rows - 1)) * hw / 2;
    const totalH = (span - 2) * hh;
    const oy = (size.h - totalH) / 2 + tileW * 0.35;
    return { tileW, hw, hh, at: (col, row) => ({ x: ox + (col - row) * hw, y: oy + (col + row) * hh }) };
  }

  function diamond(x, y, hw, hh) {
    ctx.beginPath();
    ctx.moveTo(x, y - hh);
    ctx.lineTo(x + hw, y);
    ctx.lineTo(x, y + hh);
    ctx.lineTo(x - hw, y);
    ctx.closePath();
  }

  function drawBlock(img, x, y, tileW, hw, hh, kind) {
    if (img) {
      ctx.drawImage(img, x - FACE.cx * tileW, y - FACE.cy * tileW, tileW, tileW);
      return;
    }
    // Placeholder block when the asset service is unreachable.
    const depth = hh * 0.9;
    ctx.fillStyle = kind === "rubble" ? "#4a3a2e" : "#3b352f";
    ctx.beginPath();
    ctx.moveTo(x - hw, y);
    ctx.lineTo(x, y + hh);
    ctx.lineTo(x + hw, y);
    ctx.lineTo(x + hw, y + depth);
    ctx.lineTo(x, y + hh + depth);
    ctx.lineTo(x - hw, y + depth);
    ctx.closePath();
    ctx.fill();
    diamond(x, y, hw, hh);
    ctx.fillStyle = kind === "rubble" ? "#6b5242" : "#57504a";
    ctx.fill();
  }

  const ease = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
  const drop = (t) => {
    const k = Math.min(1, Math.max(0, t));
    if (k < 0.72) return (k / 0.72) ** 2;
    const b = (k - 0.86) / 0.14;
    return 1 - 0.08 * (1 - b * b);
  };

  function paint(now) {
    if (!state || !size.w) return;
    const { cols, rows } = ground;
    const { tileW, hw, hh, at } = layout();
    const t = reduceMotion ? 1e6 : now - started;
    const tileEnd = (cols + rows) * 28 + 420;
    const unitAt = (i) => tileEnd + i * 70;
    const rubbleAt = (i) => tileEnd + state.army.length * 70 + 200 + i * 150;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const occupants = new Map(state.army.map((a, i) => [a.row * cols + a.col, { ...a, i }]));
    const rubbleIndex = new Map(state.rubble.map((r, i) => [r.row * cols + r.col, i]));

    for (let sum = 0; sum <= cols + rows - 2; sum += 1) {
      for (let col = Math.max(0, sum - rows + 1); col <= Math.min(cols - 1, sum); col += 1) {
        const row = sum - col;
        const key = row * cols + col;
        const { x, y } = at(col, row);
        const rise = ease((t - sum * 28) / 420);
        if (rise <= 0) continue;
        ctx.globalAlpha = rise;
        const lift = (1 - rise) * hh * 2;
        drawBlock(art.tile, x, y + lift, tileW, hw, hh, "tile");

        const zone = row < ZONE_DEPTH ? "a" : row >= rows - ZONE_DEPTH ? "b" : null;
        if (zone) {
          diamond(x, y + lift, hw * 0.94, hh * 0.94);
          ctx.fillStyle = zone === "b" ? "rgba(236,118,52,0.22)" : "rgba(140,175,205,0.3)";
          ctx.fill();
          ctx.strokeStyle = zone === "b" ? "rgba(255,150,80,0.55)" : "rgba(190,215,235,0.55)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        const r = rubbleIndex.get(key);
        if (r !== undefined) {
          const k = (t - rubbleAt(r)) / 620;
          if (k > 0) {
            const fall = drop(k);
            ctx.globalAlpha = Math.min(1, k * 3);
            drawBlock(art.rubble, x, y - (1 - fall) * size.h * 0.55, tileW, hw, hh, "rubble");
            ctx.globalAlpha = 1;
            if (k > 0.72 && k < 2.2) {
              const burst = (k - 0.72) / 1.48;
              const glow = ctx.createRadialGradient(x, y, 0, x, y, hw * (0.6 + burst * 1.2));
              glow.addColorStop(0, `rgba(255,140,60,${0.55 * (1 - burst)})`);
              glow.addColorStop(1, "rgba(255,140,60,0)");
              ctx.globalCompositeOperation = "lighter";
              ctx.fillStyle = glow;
              ctx.fillRect(x - hw * 2, y - hw * 2, hw * 4, hw * 4);
              ctx.globalCompositeOperation = "source-over";
            }
            if (k >= 1) {
              // Coals breathing in the rubble.
              const pulse = 0.5 + 0.5 * Math.sin(now / 700 + r * 1.7);
              const glow = ctx.createRadialGradient(x, y, 0, x, y, hw * 0.8);
              glow.addColorStop(0, `rgba(255,120,40,${0.12 + pulse * 0.12})`);
              glow.addColorStop(1, "rgba(255,120,40,0)");
              ctx.globalCompositeOperation = "lighter";
              ctx.fillStyle = glow;
              ctx.fillRect(x - hw, y - hw, hw * 2, hw * 2);
              ctx.globalCompositeOperation = "source-over";
            }
          }
        }

        const occupant = occupants.get(key);
        if (occupant) {
          const k = ease((t - unitAt(occupant.i)) / 480);
          if (k > 0) drawUnit(occupant, x, y, tileW, hw, hh, k);
        }
      }
    }
  }

  function drawUnit({ unit, side }, x, y, tileW, hw, hh, k) {
    const img = art.units[unit.key];
    ctx.globalAlpha = k;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.beginPath();
    ctx.ellipse(x, y + hh * 0.1, hw * 0.42, hh * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    const height = tileW * 0.95;
    const width = img ? height * (img.naturalWidth / img.naturalHeight) : height * 0.45;
    const footY = y + hh * 0.15 + (1 - k) * -hh * 1.5;
    ctx.save();
    ctx.translate(x, footY);
    if (side === "a") ctx.scale(-1, 1);
    if (img) {
      ctx.drawImage(img, -width / 2, -height * 0.97, width, height);
    } else {
      ctx.fillStyle = unit.color;
      ctx.fillRect(-width / 4, -height * 0.7, width / 2, height * 0.7);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function loop(now) {
    if (!running) return;
    paint(now);
    requestAnimationFrame(loop);
  }

  function play() {
    started = performance.now();
    if (reduceMotion) {
      paint(started);
      return;
    }
    if (!running && visible) {
      running = true;
      requestAnimationFrame(loop);
    }
  }

  async function scramble(seed) {
    const target = hex(seed).slice(0, 16);
    if (reduceMotion) {
      seedOut.textContent = `${target}…`;
      return;
    }
    const glyphs = "0123456789abcdef";
    for (let step = 0; step <= 16; step += 1) {
      seedOut.textContent = `${target.slice(0, step)}${[...target.slice(step)].map(() => glyphs[Math.floor(Math.random() * 16)]).join("")}…`;
      await new Promise((resolve) => setTimeout(resolve, 28));
    }
  }

  async function reseed(replay = true) {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const rubble = await blockedTiles(ground.cols, ground.rows, seed);
    // Two different races face each other on every roll.
    const [mine, foe] = [...races].sort(() => Math.random() - 0.5);
    const theirs = sampleArmy(ground.budget, foe);
    const yours = sampleArmy(ground.budget, mine);
    const army = [
      ...placeArmy(theirs, ground.cols, ground.rows, "a"),
      ...placeArmy(yours, ground.cols, ground.rows, "b"),
    ];
    state = { rubble, army };
    facts.rubble.textContent = `${rubble.length} tiles`;
    void scramble(seed);
    if (replay) play();
    else {
      // Keep the board standing; only the rubble falls again.
      const { cols, rows } = ground;
      started = performance.now() - ((cols + rows) * 28 + 420 + army.length * 70);
      if (!running && visible && !reduceMotion) {
        running = true;
        requestAnimationFrame(loop);
      } else paint(performance.now());
    }
  }

  function select(bg) {
    ground = bg;
    for (const tab of tabs.children) {
      const on = tab.dataset.slug === bg.slug;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    facts.stake.textContent = `${bg.stake / 1e9} SOL`;
    facts.budget.textContent = String(bg.budget);
    facts.grid.textContent = `${bg.cols} × ${bg.rows}`;
    void reseed();
  }

  roll.addEventListener("click", () => void reseed(false));

  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible && !art.loading) {
      art.loading = Promise.all([
        loadImage(TILE).then((img) => { art.tile = img; }),
        loadImage(RUBBLE).then((img) => { art.rubble = img; }),
        ...allUnits.map((u) => loadImage(unitPath(u)).then((img) => { art.units[u.key] = img; })),
      ]).then(() => select(ground));
    }
    if (visible && !running && state && !reduceMotion) {
      running = true;
      requestAnimationFrame(loop);
    }
    if (!visible) running = false;
  }, { rootMargin: "120px 0px" }).observe(canvas);
}

board(document.querySelector(".board"));

// ---------------------------------------------------------------- the line

const prose = {
  guard: "A heavy round shield on the left arm, a short spear, and a thick ash-colored cloak. Slow and solid.",
  skirmisher: "Light leather, twin short blades, a lean build, and an ember-orange sash. The stance is a quick forward lean.",
  archer: "A longbow at the side, a quiver, and a hooded bone-pale wrap on a narrow frame.",
  vanguard: "A tall greatsword planted point-down beside the body, plate scraps over cloth, broad shoulders.",
  warden: "The largest soldier. A tower shield, an iron mask, and a heavy coat. Still and imposing.",
  thornling: "Thin thorn stems braided like wire, ember glowing between the strands, long whip arms ending in spikes.",
  briarsling: "A wicked rose on a stem of dark vines. One arm coils into a sling loaded with thorns.",
  elderoak: "The oldest of the grove. A hearth burns in its hollow chest and a lantern hangs from one branch.",
  clawling: "A squat crab in a scarred slate carapace patched with iron, one crushing claw far too large for it.",
  eelsnare: "A slick eel-man with a fin down its spine, a barbed line in one hand and a hooked gaff in the other.",
  spineshot: "A pufferfish bristling with quills, a bandolier of spares across its chest, one arm drawn back to throw.",
  tidecaller: "A jellyfish shaman in torn sailcloth, tendrils veiling its face, a diving-bell lantern at its side.",
};

// Each race in a line, under the race tabs.
const peoples = {
  ashborn: "The cheapest army. Soot and bone that rose from the burned city, many bodies for the budget.",
  rootborn: "The dearest army. The last grove walking on its roots: few soldiers, each one huge.",
  deeplings: "The middle army. Shell and scale from the drowned harbor, between the ash and the grove in price.",
};

// Cast names from battle.md; the numbers come from the catalog.
const castNames = {
  guard: "Shield bash.", skirmisher: "Sprint.", archer: "Long draw.", vanguard: "Challenge.", warden: "Mending.",
  thornling: "Thorn burst.", briarsling: "Thorn sling.", elderoak: "Hearth sap.",
  clawling: "Crush.", eelsnare: "Snare.", spineshot: "Spine spray.", tidecaller: "Undertow.",
};
const around = (c) => (c.aoe ? ` and foes within ${c.aoe} of it` : "");
const recover = (c) => (c.cooldown ? `, then ${c.cooldown} ${c.cooldown === 1 ? "round" : "rounds"} to recover` : "");
const casts = {
  none: (c) => `${c.damage} damage to a foe${around(c)}, range ${c.range}${recover(c)}.`,
  push: (c) => `${c.damage} damage and pushes a foe${around(c)} ${c.power} ${c.power === 1 ? "tile" : "tiles"} back, range ${c.range}${recover(c)}.`,
  sprint: (c) => `Movement × ${1 + c.power} for ${c.rounds} rounds${recover(c)}.`,
  reach: (c) => `+${c.power} attack range for ${c.rounds} rounds${recover(c)}.`,
  taunt: (c, unit) => `The target${around(c)} walks toward the ${unit.name} for ${c.rounds} rounds. Range ${c.range}${recover(c)}.`,
  heal: (c) => `Heals ${c.aoe ? `an ally or itself, and allies within ${c.aoe} of it,` : "one ally or itself"} for up to ${c.power}, range ${c.range}${recover(c)}.`,
};

function roster() {
  const line = document.querySelector(".line");
  const tabs = document.querySelector(".peoples");
  const blurb = document.querySelector(".people-blurb");
  const list = document.querySelector(".roster");
  const fields = Object.fromEntries([...document.querySelectorAll("[data-unit]")].map((el) => [el.dataset.unit, el]));
  const dossier = document.querySelector(".dossier");
  let race = races[0];
  let buttons = [];
  let current = -1;
  let lit = false;

  for (const people of races) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.role = "tab";
    tab.textContent = people.name;
    tab.dataset.slug = people.slug;
    tab.addEventListener("click", () => pick(people));
    tabs.appendChild(tab);
  }

  tabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const index = races.indexOf(race) + (event.key === "ArrowRight" ? 1 : -1);
    const next = races[(index + races.length) % races.length];
    pick(next);
    tabs.querySelector(`[data-slug="${next.slug}"]`).focus();
  });

  // On narrow screens the roster is a snap carousel: keep it centered on the selection.
  const center = (i, behavior) => {
    const b = buttons[i];
    list.scrollTo({ left: b.offsetLeft + b.offsetWidth / 2 - list.clientWidth / 2, behavior });
  };

  function show(i, follow = true) {
    if (i === current) return;
    current = i;
    if (follow && list.scrollWidth > list.clientWidth) center(i, reduceMotion ? "auto" : "smooth");
    const unit = race.units[i];
    buttons.forEach((b, j) => {
      b.setAttribute("aria-selected", String(j === i));
      b.tabIndex = j === i ? 0 : -1;
    });
    Object.assign(fields.name, { textContent: unit.name });
    fields.cost.textContent = String(unit.cost);
    fields.body.textContent = prose[unit.slug] ?? "";
    for (const stat of ["hp", "atk", "range", "speed"]) fields[stat].textContent = String(unit[stat]);
    fields.castName.textContent = castNames[unit.slug] ?? "Cast.";
    fields.castText.textContent = casts[unit.cast.effect]?.(unit.cast, unit) ?? unit.cast.effect;
    if (!reduceMotion) {
      dossier.classList.remove("swap");
      void dossier.offsetWidth;
      dossier.classList.add("swap");
    }
  }

  function pick(people) {
    race = people;
    for (const tab of tabs.children) {
      const on = tab.dataset.slug === people.slug;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    blurb.textContent = peoples[people.slug] ?? "";
    list.style.setProperty("--count", String(people.units.length));
    buttons = people.units.map((unit, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "tab";
      button.className = "soldier";
      button.style.setProperty("--i", String(i));
      button.dataset.slug = unit.slug;
      button.setAttribute("aria-label", unit.name);
      const figure = document.createElement("figure");
      figure.className = "soldier-art";
      figure.dataset.asset = unitPath(unit);
      figure.dataset.alt = "";
      const name = document.createElement("span");
      name.className = "soldier-name";
      name.textContent = unit.name;
      button.append(figure, name);
      button.addEventListener("click", () => show(i));
      button.addEventListener("pointerenter", (event) => {
        if (event.pointerType === "mouse") show(i);
      });
      return button;
    });
    list.replaceChildren(...buttons);
    if (lit) for (const figure of list.querySelectorAll("[data-asset]")) void mountImage(figure);
    current = -1;
    // Ashborn opens on the Vanguard; the other races open on their first unit.
    const first = Math.max(0, people.units.findIndex((u) => u.slug === "vanguard"));
    show(first, false);
    requestAnimationFrame(() => center(first, "auto"));
  }

  list.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const count = race.units.length;
    const next = (current + (event.key === "ArrowRight" ? 1 : -1) + count) % count;
    show(next);
    buttons[next].focus();
  });

  let settle = 0;
  list.addEventListener("scroll", () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      const mid = list.scrollLeft + list.clientWidth / 2;
      const nearest = buttons.reduce((best, b, j) => {
        const d = Math.abs(b.offsetLeft + b.offsetWidth / 2 - mid);
        return d < best.d ? { d, j } : best;
      }, { d: Infinity, j: current }).j;
      show(nearest, false);
    }, 120);
  }, { passive: true });

  pick(race);

  new IntersectionObserver(([entry], observer) => {
    if (!entry.isIntersecting) return;
    observer.disconnect();
    lit = true;
    line.classList.add("lit");
    for (const figure of list.querySelectorAll("[data-asset]")) void mountImage(figure);
  }, { rootMargin: "200px 0px" }).observe(list);
}

roster();

// ---------------------------------------------------------------- the front: live numbers

// The game server proxies /api to the indexer (in dev, the game's Vite server does, or reads the
// local ledger when the game runs without a chain). The numbers are public and sent with CORS.
const front = document.querySelector(".front");
const STATS_POLL_MS = 30_000;
const shown = new Map();

function lamportsToSol(lamports) {
  const sol = Number(BigInt(lamports) / 1_000_000n) / 1000;
  return sol >= 100 ? Math.round(sol).toLocaleString("en") : sol.toLocaleString("en", { maximumFractionDigits: 2 });
}

// Counts up from the last value shown, unless motion is reduced or the value is not a number.
function setStat(el, value, format = (n) => Math.round(n).toLocaleString("en")) {
  const target = Number(value);
  const from = shown.get(el) ?? 0;
  shown.set(el, target);
  if (!Number.isFinite(target) || reduceMotion || from === target) {
    el.textContent = Number.isFinite(target) ? format(target) : String(value);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 900);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = format(from + (target - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderFronts(stats) {
  const list = front.querySelector(".fronts");
  const busiest = Math.max(1, ...stats.battlegrounds.map((ground) => ground.battlesFought));
  list.replaceChildren(...catalog.battlegrounds.map((spec) => {
    const ground = stats.battlegrounds.find((item) => item.battlegroundId === spec.id) || { locked: 0, battlesFought: 0 };
    const item = document.createElement("li");
    item.style.setProperty("--share", String(ground.battlesFought / busiest));
    const waiting = ground.locked === 1 ? "1 army waits" : `${ground.locked} armies wait`;
    item.innerHTML = `
      <span class="front-name"></span>
      <span class="front-stake"></span>
      <span class="front-bar" aria-hidden="true"><i></i></span>
      <span class="front-fought"></span>
      <span class="front-waiting${ground.locked ? " is-waiting" : ""}"></span>`;
    item.querySelector(".front-name").textContent = spec.name;
    item.querySelector(".front-stake").textContent = `${spec.stake / 1e9} SOL`;
    item.querySelector(".front-fought").textContent = `${ground.battlesFought.toLocaleString("en")} fought`;
    item.querySelector(".front-waiting").textContent = waiting;
    return item;
  }));
}

function ago(seconds) {
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

let lastStats = 0;

async function loadStats() {
  try {
    const response = await fetch(`${origin}/api/stats`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(String(response.status));
    const stats = await response.json();
    const value = (key) => front.querySelector(`[data-stat="${key}"]`);
    setStat(value("battlesFought"), stats.battlesFought);
    setStat(value("battlesToday"), stats.battlesToday);
    setStat(value("players"), stats.players);
    setStat(value("armiesLocked"), stats.armiesLocked);
    value("staked").textContent = lamportsToSol(stats.stakedLamports);
    value("drawShare").textContent = stats.battlesFought ? `${Math.round((100 * stats.draws) / stats.battlesFought)}%` : "—";
    renderFronts(stats);
    lastStats = Date.now();
    front.dataset.state = "live";
  } catch {
    // Keep the last numbers if there were any; otherwise say the front is quiet.
    if (!lastStats) front.dataset.state = "quiet";
  }
  updatePulse();
}

function updatePulse() {
  const label = front.querySelector("[data-live]");
  if (front.dataset.state === "quiet") label.textContent = "No signal";
  else if (lastStats) label.textContent = `Live · updated ${ago(Math.round((Date.now() - lastStats) / 1000))}`;
}

if (front) {
  let timer = 0;
  let inFlight = false;
  const poll = () => {
    // A tab coming back into view while a request is out must not start a second one.
    if (inFlight) return;
    inFlight = true;
    window.clearTimeout(timer);
    loadStats().finally(() => {
      inFlight = false;
      timer = window.setTimeout(() => {
        if (document.visibilityState === "visible") poll();
      }, STATS_POLL_MS);
    });
  };
  // Load when the section is near, then keep it current while the page is visible.
  new IntersectionObserver(([entry], observer) => {
    if (!entry.isIntersecting) return;
    observer.disconnect();
    front.classList.add("lit");
    poll();
  }, { rootMargin: "400px 0px" }).observe(front);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && front.classList.contains("lit")) poll();
  });
  window.setInterval(updatePulse, 5_000);
}
