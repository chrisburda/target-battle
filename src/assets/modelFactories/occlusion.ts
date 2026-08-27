import * as THREE from 'three';

/**
 * Bakes ambient occlusion into a built character's vertex colours.
 *
 * This is the difference between the hand-built fighters and the generated
 * ones, and it is not a colour problem. A generated asset arrives with
 * occlusion painted into its albedo, so every crease — under the jaw, where an
 * arm meets a torso, between the legs — already carries shadow before a single
 * light touches it. The fighters here are assembled from lathes and spheres
 * lit by one directional key, and every one of those junctions stays exactly as
 * bright as the surface around it. The result reads as inflated rather than
 * solid, and no amount of re-lighting fixes it: the light is doing its job, the
 * geometry just never tells it anything is tucked away.
 *
 * The method is point-based occlusion. Every triangle in the model becomes a
 * small disc of known area and orientation; every vertex sums how much of its
 * hemisphere those discs cover. Convex surfaces come out untouched for free —
 * a disc on the far side of a sphere faces away from the receiver, so it
 * contributes nothing — which is exactly the behaviour wanted and the reason
 * this needs no explicit self-occlusion test.
 *
 * It runs once per fighter at build time and never again; the pose changes at
 * runtime but the creases do not move enough to matter, which is the same
 * trade every baked-AO pipeline makes.
 */

/** Merged geometry is non-indexed, so one position appears three times. */
type Sample = {
  /** Accumulated normal at a position, normalised once gathering is done. */
  nx: number;
  ny: number;
  nz: number;
  x: number;
  y: number;
  z: number;
  ao: number;
};

export type OcclusionOptions = {
  /**
   * How far a surface can shade another, in model units.
   *
   * A fighter stands about 2.2 units tall here, so 0.5 reaches from a shoulder
   * into the armpit and from the jaw onto the chest without letting the head
   * darken the feet. Raising it does not add depth so much as flatten
   * everything toward a uniform grey.
   */
  radius?: number;
  /** Scales the accumulated obscurance before it darkens the surface. */
  strength?: number;
  /** Darkest the bake is allowed to go, so creases never read as holes. */
  floor?: number;
  /**
   * Weight of a plain sky term mixed in alongside the computed occlusion.
   *
   * Point occlusion says nothing about a convex underside — the underside of a
   * belly has nothing near it to be shaded by, yet in life it faces away from
   * the sky and sits darker. A little of that gradient restores the read.
   */
  sky?: number;
  /**
   * Depth of the painted mottling, as a fraction either side of flat.
   *
   * The generated assets are never one flat colour anywhere — their albedo
   * wanders by a few percent across any given panel, and that wander is a large
   * part of why they read as painted rather than moulded. Zero disables it.
   */
  mottle?: number;
};

/**
 * Value noise in three dimensions, smoothstep-interpolated.
 *
 * Deliberately not a texture. These models are assembled from spheres, lathes
 * and extrusions and then merged, so every primitive brings its own 0..1 UV
 * island; any map applied through those UVs restarts at every seam and changes
 * scale between a head and a finger. Sampling by world position sidesteps the
 * parameterisation entirely — the mottling is continuous across a merge and the
 * same size on every part, which is what a hand-painted map would have been.
 */
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function noise3(x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const ty = y - y0;
  const tz = z - z0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const sz = tz * tz * (3 - 2 * tz);

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const corner = (i: number, j: number, k: number) => hash3(x0 + i, y0 + j, z0 + k);

  const x00 = lerp(corner(0, 0, 0), corner(1, 0, 0), sx);
  const x10 = lerp(corner(0, 1, 0), corner(1, 1, 0), sx);
  const x01 = lerp(corner(0, 0, 1), corner(1, 0, 1), sx);
  const x11 = lerp(corner(0, 1, 1), corner(1, 1, 1), sx);
  return lerp(lerp(x00, x10, sy), lerp(x01, x11, sy), sz);
}

/**
 * Quantised position key, packed into one number.
 *
 * Numeric rather than a template string, and the difference is not academic:
 * this runs once per vertex and the grid query below runs twenty-seven times
 * per sample, so a string key meant something like half a million allocations
 * and hashes per fighter. Sixteen bits per axis at a tenth-of-a-millimetre
 * quantum covers ±3.2 model units, comfortably past anything a fighter
 * occupies, and the packed result stays inside the safe integer range.
 */
function keyFor(x: number, y: number, z: number): number {
  const qx = Math.round(x * 10000) + 32768;
  const qy = Math.round(y * 10000) + 32768;
  const qz = Math.round(z * 10000) + 32768;
  return (qx * 65536 + qy) * 65536 + qz;
}

/** Grid cell key. Same trick, coarser: a fighter spans only a few cells. */
function cellKey(x: number, y: number, z: number): number {
  return ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
}

export type OcclusionReport = {
  samples: number;
  discs: number;
  min: number;
  mean: number;
  /** Wall-clock cost of the bake, so the budget stays visible rather than felt. */
  ms: number;
};

export function bakeAmbientOcclusion(
  root: THREE.Object3D,
  options: OcclusionOptions = {},
): OcclusionReport {
  const radius = options.radius ?? 0.55;
  /*
   * Strength is the number this pass most wants to get wrong.
   *
   * At 2.8 the bake looked convincing on its own and averaged 0.47 across the
   * model — it was halving every albedo in the palette, undoing the grading it
   * was meant to sit alongside. A baked map belongs around 0.85 mean with its
   * darkest creases near 0.45; the creases are what carry the read, not the
   * broad surface, and darkening the broad surface only costs saturation.
   */
  const strength = options.strength ?? 0.6;
  const floor = options.floor ?? 0.5;
  const skyWeight = options.sky ?? 0.12;
  const mottleDepth = options.mottle ?? 0.15;
  const started = performance.now();

  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();

  const meshes: THREE.Mesh[] = [];
  root.traverse((node) => {
    const asMesh = node as THREE.Mesh;
    if (!asMesh.isMesh) return;
    // The contact shadow is a flat decal under the feet, not part of the body;
    // baking it in makes a dark ring appear to float on the ground.
    if (asMesh.name === 'contactShadow') return;
    if (asMesh.geometry.getAttribute('position')) meshes.push(asMesh);
  });
  if (meshes.length === 0) return { samples: 0, discs: 0, min: 1, mean: 1, ms: 0 };

  /*
   * Gathering is keyed by position rather than by vertex index. Merged
   * geometry is non-indexed and the primitives meet at shared seams, so the
   * same point in space turns up several times with several normals. Solving
   * once per position and averaging those normals both cuts the work by about
   * two thirds and — more usefully — makes the result continuous across the
   * seam where a lathe meets a sphere, which a per-vertex solve leaves as a
   * visible line.
   */
  const samples = new Map<number, Sample>();
  const perMesh: Array<{ mesh: THREE.Mesh; keys: number[] }> = [];

  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  const local = new THREE.Matrix4();

  for (const mesh of meshes) {
    local.copy(toRoot).multiply(mesh.matrixWorld);
    normalMatrix.getNormalMatrix(local);
    const positions = mesh.geometry.getAttribute('position');
    const normals = mesh.geometry.getAttribute('normal');
    const keys: number[] = new Array(positions.count);

    for (let i = 0; i < positions.count; i += 1) {
      point.fromBufferAttribute(positions, i).applyMatrix4(local);
      const key = keyFor(point.x, point.y, point.z);
      keys[i] = key;
      let sample = samples.get(key);
      if (!sample) {
        sample = { x: point.x, y: point.y, z: point.z, nx: 0, ny: 0, nz: 0, ao: 1 };
        samples.set(key, sample);
      }
      if (normals) {
        normal.fromBufferAttribute(normals, i).applyMatrix3(normalMatrix).normalize();
        sample.nx += normal.x;
        sample.ny += normal.y;
        sample.nz += normal.z;
      }
    }
    perMesh.push({ mesh, keys });
  }

  const list = [...samples.values()];
  for (const sample of list) {
    const length = Math.hypot(sample.nx, sample.ny, sample.nz) || 1;
    sample.nx /= length;
    sample.ny /= length;
    sample.nz /= length;
  }

  // --- occluder discs ------------------------------------------------------
  /*
   * One disc per triangle, capped by striding. Past a couple of thousand discs
   * the bake stops changing and only gets slower; below a few hundred the
   * creases turn blotchy because a single disc covers too much solid angle.
   */
  const TARGET_DISCS = 1000;
  let triangleTotal = 0;
  for (const mesh of meshes) {
    const positions = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    triangleTotal += (index ? index.count : positions.count) / 3;
  }
  const stride = Math.max(1, Math.floor(triangleTotal / TARGET_DISCS));

  const discX: number[] = [];
  const discY: number[] = [];
  const discZ: number[] = [];
  const discNX: number[] = [];
  const discNY: number[] = [];
  const discNZ: number[] = [];
  const discArea: number[] = [];

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();

  for (const mesh of meshes) {
    local.copy(toRoot).multiply(mesh.matrixWorld);
    const positions = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const count = (index ? index.count : positions.count) / 3;

    for (let t = 0; t < count; t += stride) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(positions, i0).applyMatrix4(local);
      b.fromBufferAttribute(positions, i1).applyMatrix4(local);
      c.fromBufferAttribute(positions, i2).applyMatrix4(local);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      cross.crossVectors(ab, ac);
      const doubleArea = cross.length();
      if (doubleArea < 1e-9) continue;
      // Striding samples the mesh, so each disc stands in for `stride`
      // triangles and has to carry their area too, or a dense mesh occludes
      // less than a coarse one of the same shape.
      discArea.push((doubleArea / 2) * stride);
      discX.push((a.x + b.x + c.x) / 3);
      discY.push((a.y + b.y + c.y) / 3);
      discZ.push((a.z + b.z + c.z) / 3);
      discNX.push(cross.x / doubleArea);
      discNY.push(cross.y / doubleArea);
      discNZ.push(cross.z / doubleArea);
    }
  }
  if (discArea.length === 0) return { samples: list.length, discs: 0, min: 1, mean: 1, ms: 0 };

  // --- uniform grid over the discs ----------------------------------------
  // Cell size is the occlusion radius, so a query touches 27 cells at most and
  // the solve stays linear in the number of samples rather than quadratic.
  const cell = radius;
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < discX.length; i += 1) {
    const key = cellKey(
      Math.floor(discX[i] / cell),
      Math.floor(discY[i] / cell),
      Math.floor(discZ[i] / cell),
    );
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i);
    else buckets.set(key, [i]);
  }

  const radiusSquared = radius * radius;
  for (const sample of list) {
    const cx = Math.floor(sample.x / cell);
    const cy = Math.floor(sample.y / cell);
    const cz = Math.floor(sample.z / cell);
    let occlusion = 0;

    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let oz = -1; oz <= 1; oz += 1) {
          const bucket = buckets.get(cellKey(cx + ox, cy + oy, cz + oz));
          if (!bucket) continue;
          for (const i of bucket) {
            const vx = discX[i] - sample.x;
            const vy = discY[i] - sample.y;
            const vz = discZ[i] - sample.z;
            const distanceSquared = vx * vx + vy * vy + vz * vz;
            if (distanceSquared > radiusSquared || distanceSquared < 1e-8) continue;
            const distance = Math.sqrt(distanceSquared);
            // Receiver must face the disc, and the disc must face back. The
            // second test is what makes convex surfaces self-shadow-free with
            // no special case: on a sphere every other triangle turns away.
            const cosReceiver =
              (sample.nx * vx + sample.ny * vy + sample.nz * vz) / distance;
            if (cosReceiver <= 0) continue;
            const cosEmitter =
              -(discNX[i] * vx + discNY[i] * vy + discNZ[i] * vz) / distance;
            if (cosEmitter <= 0) continue;
            const area = discArea[i];
            const form = (cosReceiver * cosEmitter * area) / (Math.PI * distanceSquared + area);
            // Fade to nothing at the radius; a hard cutoff prints the grid.
            occlusion += form * (1 - distanceSquared / radiusSquared);
          }
        }
      }
    }

    const shaded = Math.max(floor, 1 - Math.min(1, occlusion * strength));
    const sky = 1 - skyWeight * (1 - (sample.ny * 0.5 + 0.5));
    // Two octaves: one at roughly the scale of a limb, one at the scale of a
    // patch on it. One octave alone reads as either blotches or noise.
    const broad = noise3(sample.x * 3.1, sample.y * 3.1, sample.z * 3.1);
    const fine = noise3(sample.x * 9.7 + 11.3, sample.y * 9.7, sample.z * 9.7 + 4.1);
    const mottle = 1 + ((broad * 0.68 + fine * 0.32) - 0.5) * mottleDepth;
    sample.ao = shaded * sky * mottle;
  }

  // --- write back ----------------------------------------------------------
  for (const { mesh, keys } of perMesh) {
    const count = mesh.geometry.getAttribute('position').count;
    let colors = mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!colors || colors.count !== count) {
      colors = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
      mesh.geometry.setAttribute('color', colors);
    }
    for (let i = 0; i < count; i += 1) {
      const value = samples.get(keys[i])?.ao ?? 1;
      colors.setXYZ(i, value, value, value);
    }
    colors.needsUpdate = true;
  }

  let min = 1;
  let total = 0;
  for (const sample of list) {
    min = Math.min(min, sample.ao);
    total += sample.ao;
  }
  return {
    samples: list.length,
    discs: discArea.length,
    min: Number(min.toFixed(3)),
    mean: Number((total / list.length).toFixed(3)),
    ms: Math.round(performance.now() - started),
  };
}
