import * as THREE from 'three';
import type { MaterialLibrary } from '../MaterialLibrary';
import type { AmmoDef } from '../../game/types';

/**
 * Ammo models. Each of the five behaves differently in flight, so each needs a
 * silhouette a player can identify mid-arc from across the arena — a lumpy
 * rock, a husked coconut, a striped melon, a scaled pine cluster and a banded
 * hive read apart at a glance even when they are 4 pixels tall.
 */

const ICO = new THREE.IcosahedronGeometry(1, 0);
const SPHERE = new THREE.SphereGeometry(1, 14, 10);
const CONE = new THREE.ConeGeometry(1, 1, 8);

/** Jitters an icosahedron into an irregular boulder. */
function rockGeometry(seed: number): THREE.BufferGeometry {
  const geometry = ICO.clone();
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const n = Math.sin(x * 12.9 + y * 4.7 + z * 7.3 + seed) * 0.5 + 0.5;
    const scale = 0.78 + n * 0.44;
    position.setXYZ(i, x * scale, y * scale * 0.86, z * scale);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export type AmmoModel = {
  root: THREE.Group;
  radius: number;
  geometries: THREE.BufferGeometry[];
};

export function createAmmoModel(materials: MaterialLibrary, def: AmmoDef): AmmoModel {
  const root = new THREE.Group();
  root.name = 'ammo-' + def.id;
  const geometries: THREE.BufferGeometry[] = [];
  const base = materials.flat(def.color, 0.9);
  const accent = materials.flat(def.accent, 0.7);

  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, name: string): THREE.Mesh => {
    const m = new THREE.Mesh(geometry, material);
    m.name = name;
    m.castShadow = true;
    root.add(m);
    return m;
  };

  switch (def.id) {
    case 'rock': {
      const geo = rockGeometry(3.1);
      geometries.push(geo);
      const body = add(geo, base, 'rockBody');
      body.scale.setScalar(0.55);
      // A lighter chipped face catches the key light and sells the spin.
      const chipGeo = rockGeometry(9.4);
      geometries.push(chipGeo);
      const chip = add(chipGeo, accent, 'rockChip');
      chip.scale.setScalar(0.34);
      chip.position.set(0.2, 0.18, 0.16);
      break;
    }
    case 'coconut': {
      const shell = add(SPHERE, base, 'shell');
      shell.scale.setScalar(0.5);
      // Three germination pores: the detail that makes it read as a coconut.
      for (let i = 0; i < 3; i += 1) {
        const angle = (i / 3) * Math.PI * 2;
        const pore = add(SPHERE, materials.eyeDark, 'pore');
        pore.scale.setScalar(0.09);
        pore.position.set(0.42, Math.cos(angle) * 0.18, Math.sin(angle) * 0.18);
      }
      // Husk fibres.
      for (let i = 0; i < 7; i += 1) {
        const angle = (i / 7) * Math.PI * 2;
        const fibre = add(CONE, accent, 'husk');
        fibre.scale.set(0.05, 0.26, 0.05);
        fibre.position.set(-0.34, Math.cos(angle) * 0.3, Math.sin(angle) * 0.3);
        fibre.rotation.z = Math.PI / 2 + 0.3;
      }
      break;
    }
    case 'melon': {
      const body = add(SPHERE, base, 'melonBody');
      body.scale.set(0.62, 0.54, 0.54);
      // Dark rind stripes as thin torus bands.
      for (let i = 0; i < 5; i += 1) {
        const stripeGeo = new THREE.TorusGeometry(0.55, 0.045, 6, 18);
        geometries.push(stripeGeo);
        const stripe = add(stripeGeo, materials.flat(0x1f4f18, 0.85), 'rindStripe');
        stripe.rotation.y = (i / 5) * Math.PI;
        stripe.rotation.x = Math.PI / 2;
        stripe.scale.set(1.05, 0.92, 1);
      }
      const stem = add(CONE, accent, 'stem');
      stem.scale.set(0.07, 0.18, 0.07);
      stem.position.y = 0.56;
      break;
    }
    case 'cluster': {
      // Pine cone: a spindle wrapped in overlapping scale rings.
      const core = add(SPHERE, base, 'core');
      core.scale.set(0.24, 0.5, 0.24);
      for (let ring = 0; ring < 5; ring += 1) {
        const t = ring / 4;
        const radius = 0.3 * Math.sin(Math.PI * (0.2 + t * 0.75));
        const count = 6;
        for (let i = 0; i < count; i += 1) {
          const angle = (i / count) * Math.PI * 2 + ring * 0.5;
          const scale = add(CONE, ring % 2 === 0 ? accent : base, 'scale');
          scale.scale.set(0.12, 0.2, 0.09);
          scale.position.set(
            Math.cos(angle) * radius,
            -0.34 + t * 0.72,
            Math.sin(angle) * radius,
          );
          scale.rotation.set(Math.sin(angle) * 0.9, -angle, -Math.cos(angle) * 0.9 + 0.4);
        }
      }
      break;
    }
    case 'hive': {
      // Teardrop lathe with horizontal comb bands and an entrance hole.
      const points: THREE.Vector2[] = [];
      for (let i = 0; i <= 12; i += 1) {
        const t = i / 12;
        const r = Math.sin(Math.PI * Math.pow(t, 0.72)) * 0.48;
        points.push(new THREE.Vector2(Math.max(0.02, r), -0.5 + t));
      }
      const hiveGeo = new THREE.LatheGeometry(points, 14);
      geometries.push(hiveGeo);
      add(hiveGeo, base, 'hiveBody');

      for (let i = 0; i < 4; i += 1) {
        const bandGeo = new THREE.TorusGeometry(0.3 + Math.sin(i * 0.9) * 0.14, 0.045, 6, 16);
        geometries.push(bandGeo);
        const band = add(bandGeo, accent, 'combBand');
        band.rotation.x = Math.PI / 2;
        band.position.y = -0.24 + i * 0.22;
      }

      const hole = add(SPHERE, materials.eyeDark, 'entrance');
      hole.scale.set(0.14, 0.1, 0.06);
      hole.position.set(0, -0.16, 0.4);
      break;
    }
    default:
      add(SPHERE, base, 'fallback').scale.setScalar(0.5);
  }

  return { root, radius: 0.55, geometries };
}

/** Small fragment thrown by the pine cluster. */
export function createFragmentModel(materials: MaterialLibrary, def: AmmoDef): AmmoModel {
  const root = new THREE.Group();
  root.name = 'fragment';
  const geo = rockGeometry(17.2);
  const body = new THREE.Mesh(geo, materials.flat(def.color, 0.85));
  body.scale.setScalar(0.26);
  body.castShadow = true;
  root.add(body);

  const tip = new THREE.Mesh(CONE, materials.flat(def.accent, 0.7));
  tip.scale.set(0.1, 0.22, 0.1);
  tip.position.y = 0.22;
  root.add(tip);

  return { root, radius: 0.26, geometries: [geo] };
}

export function disposeSharedAmmoGeometry(): void {
  ICO.dispose();
  SPHERE.dispose();
  CONE.dispose();
}
