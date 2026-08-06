import * as THREE from "three";
import type { ActorClip } from "./animation.js";

/*
 * The player rig — boxes, a skeleton of pivots, and three levels of detail.
 *
 * Voxel art is boxes, so this builds them rather than loading them. That is not
 * a stand-in for a GLB: it means the package ships with no binary asset, no
 * loader, no fetch and no CDN, and it draws the same offline as online. A file
 * on disk would have to be versioned, licensed, decoded and kept in sync with
 * the clip names; twenty lines of `BoxGeometry` do not.
 *
 * The parts hang off pivots at the shoulder and hip rather than sitting at
 * absolute positions, which is what lets a pose be a rotation instead of a
 * teleport — and what makes a running gait possible at all.
 */

export type RigTier = "low" | "medium" | "hero";

export interface RigColors {
  /** Jersey and sleeves. */
  primary: number;
  /** Helmet, pads and pants. */
  secondary: number;
}

/**
 * Shared geometry, keyed by size.
 *
 * Twenty-two players are the same handful of boxes over and over. Allocating a
 * `BoxGeometry` per part per actor would mean several hundred buffers holding
 * maybe a dozen distinct shapes between them.
 */
const geometryCache = new Map<string, THREE.BoxGeometry>();

function box(w: number, h: number, d: number): THREE.BoxGeometry {
  const key = `${w}:${h}:${d}`;
  let geometry = geometryCache.get(key);
  if (!geometry) {
    geometry = new THREE.BoxGeometry(w, h, d);
    geometryCache.set(key, geometry);
  }
  return geometry;
}

/** Release the shared box geometries. Call once, when the last scene dies. */
export function disposeRigGeometries(): void {
  for (const geometry of geometryCache.values()) geometry.dispose();
  geometryCache.clear();
}

type Part = {
  /** Size in yards. */
  size: [number, number, number];
  /** Offset from its pivot. */
  at: [number, number, number];
  paint: "primary" | "secondary";
  /** Which pivot it hangs from. Absent means the body itself. */
  limb?: Limb;
  /** Lowest tier that draws it. */
  from: RigTier;
};

type Limb = "armL" | "armR" | "legL" | "legR";

const TIER_RANK: Record<RigTier, number> = { low: 0, medium: 1, hero: 2 };

/*
 * A player is about 1.95 yards tall, which is right for a six-foot human on a
 * field measured in yards — the same units the engine and the choreographer
 * already speak, so nothing has to convert.
 *
 * Shoulders sit at 1.5 and hips at 0.85; the limb pivots live there, so a
 * rotation swings the whole limb from the joint the way a real one does.
 */
export const SHOULDER_Y = 1.5;
export const HIP_Y = 0.85;

const PARTS: readonly Part[] = [
  // ── Always drawn ────────────────────────────────────────────────────────
  { size: [0.44, 0.4, 0.46], at: [0, 1.72, 0], paint: "secondary", from: "low" },
  { size: [0.62, 0.66, 0.42], at: [0, 1.18, 0], paint: "primary", from: "low" },
  { size: [0.52, 0.2, 0.4], at: [0, 0.78, 0], paint: "secondary", from: "low" },
  // Limbs hang down from their pivots, so they sit at negative y.
  { size: [0.2, 0.62, 0.24], at: [0, -0.31, 0], paint: "secondary", limb: "legL", from: "low" },
  { size: [0.2, 0.62, 0.24], at: [0, -0.31, 0], paint: "secondary", limb: "legR", from: "low" },
  { size: [0.17, 0.56, 0.19], at: [0, -0.28, 0], paint: "primary", limb: "armL", from: "low" },
  { size: [0.17, 0.56, 0.19], at: [0, -0.28, 0], paint: "primary", limb: "armR", from: "low" },

  // ── Medium: the silhouette that says "football" rather than "person" ────
  { size: [0.26, 0.22, 0.46], at: [-0.42, 1.42, 0], paint: "secondary", from: "medium" },
  { size: [0.26, 0.22, 0.46], at: [0.42, 1.42, 0], paint: "secondary", from: "medium" },
  // Facemask, forward of the helmet — the cue that tells you which way he faces.
  { size: [0.3, 0.12, 0.1], at: [0, 1.63, 0.26], paint: "primary", from: "medium" },
  { size: [0.22, 0.1, 0.3], at: [0, -0.6, 0.04], paint: "primary", limb: "legL", from: "medium" },
  { size: [0.22, 0.1, 0.3], at: [0, -0.6, 0.04], paint: "primary", limb: "legR", from: "medium" },

  // ── Hero: detail that only survives a close camera ───────────────────────
  { size: [0.1, 0.42, 0.48], at: [0, 1.74, 0], paint: "primary", from: "hero" },
  { size: [0.19, 0.16, 0.21], at: [0, -0.62, 0], paint: "secondary", limb: "armL", from: "hero" },
  { size: [0.19, 0.16, 0.21], at: [0, -0.62, 0], paint: "secondary", limb: "armR", from: "hero" },
  { size: [0.5, 0.12, 0.44], at: [0, 0.9, 0], paint: "secondary", from: "hero" },
  { size: [0.24, 0.3, 0.02], at: [0, 1.2, 0.22], paint: "secondary", from: "hero" },
  { size: [0.24, 0.3, 0.02], at: [0, 1.2, -0.22], paint: "secondary", from: "hero" },
  { size: [0.22, 0.14, 0.26], at: [0, -0.34, 0.02], paint: "primary", limb: "legL", from: "hero" },
  { size: [0.22, 0.14, 0.26], at: [0, -0.34, 0.02], paint: "primary", limb: "legR", from: "hero" },
];

const LIMB_ORIGIN: Record<Limb, [number, number, number]> = {
  armL: [-0.4, SHOULDER_Y, 0],
  armR: [0.4, SHOULDER_Y, 0],
  legL: [-0.15, HIP_Y, 0],
  legR: [0.15, HIP_Y, 0],
};

/**
 * One player, built at a given level of detail.
 *
 * `body` is what a pose moves; `limbs` is what a pose rotates. Everything else
 * about the actor — where it stands, which way it faces — belongs to the caller.
 */
export class PlayerRig {
  readonly group = new THREE.Group();
  readonly body = new THREE.Group();
  readonly limbs: Record<Limb, THREE.Group>;

  private readonly primary: THREE.MeshLambertMaterial;
  private readonly secondary: THREE.MeshLambertMaterial;
  private readonly shadow: THREE.Mesh;
  private tier: RigTier;

  constructor(colors: RigColors, tier: RigTier = "medium") {
    this.tier = tier;
    this.primary = new THREE.MeshLambertMaterial({ color: colors.primary });
    this.secondary = new THREE.MeshLambertMaterial({ color: colors.secondary });

    this.limbs = {
      armL: new THREE.Group(),
      armR: new THREE.Group(),
      legL: new THREE.Group(),
      legR: new THREE.Group(),
    };
    for (const [limb, origin] of Object.entries(LIMB_ORIGIN)) {
      this.limbs[limb as Limb].position.set(...origin);
      this.body.add(this.limbs[limb as Limb]);
    }

    /*
     * A blob under each player. Orders of magnitude cheaper than a shadow map
     * and, at broadcast distance, the only cue that actually reads: without it
     * twenty-two players look like they are hovering.
     *
     * It hangs off `group` rather than `body`, so a man on the ground keeps his
     * shadow on the ground.
     */
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.5, 12),
      new THREE.MeshBasicMaterial({ color: 0x0a1a0a, transparent: true, opacity: 0.28 }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.02;

    this.group.add(this.body, this.shadow);
    this.build();
  }

  /** Meshes for the current tier, replacing whatever was there. */
  private build(): void {
    for (const parent of [this.body, ...Object.values(this.limbs)]) {
      for (const child of [...parent.children]) {
        if (child instanceof THREE.Mesh) parent.remove(child);
      }
    }

    for (const part of PARTS) {
      if (TIER_RANK[part.from] > TIER_RANK[this.tier]) continue;
      const mesh = new THREE.Mesh(
        box(...part.size),
        part.paint === "primary" ? this.primary : this.secondary,
      );
      mesh.position.set(...part.at);
      (part.limb ? this.limbs[part.limb] : this.body).add(mesh);
    }
  }

  setTier(tier: RigTier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.build();
  }

  currentTier(): RigTier {
    return this.tier;
  }

  /** Triangles in the current tier — what the LOD ladder actually buys. */
  triangleCount(): number {
    let triangles = 0;
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        const index = object.geometry.getIndex();
        const position = object.geometry.getAttribute("position");
        triangles += (index ? index.count : position.count) / 3;
      }
    });
    return triangles;
  }

  setColors(colors: RigColors): void {
    this.primary.color.setHex(colors.primary);
    this.secondary.color.setHex(colors.secondary);
  }

  /**
   * Stand the player in a pose.
   *
   * `phase` advances with distance travelled rather than with time, so a player
   * standing still has still feet. Driving a gait off the clock instead is what
   * produces the classic bug of twenty-two men jogging on the spot.
   */
  pose(clip: ActorClip, phase: number): void {
    const { armL, armR, legL, legR } = this.limbs;
    const reset = () => {
      this.body.position.set(0, 0, 0);
      this.body.rotation.set(0, 0, 0);
      for (const limb of [armL, armR, legL, legR]) limb.rotation.set(0, 0, 0);
    };
    reset();

    switch (clip) {
      case "run":
      case "backpedal": {
        // Opposite arm to leg, which is the thing the eye actually checks.
        const swing = Math.sin(phase) * (clip === "run" ? 0.85 : 0.4);
        legL.rotation.x = swing;
        legR.rotation.x = -swing;
        armL.rotation.x = -swing * 0.8;
        armR.rotation.x = swing * 0.8;
        this.body.rotation.x = clip === "run" ? 0.1 : -0.12;
        break;
      }
      case "stance":
        this.body.position.y = -0.12;
        this.body.rotation.x = 0.28;
        legL.rotation.x = 0.3;
        legR.rotation.x = -0.3;
        armL.rotation.x = -0.5;
        armR.rotation.x = -0.5;
        break;
      case "block":
        this.body.rotation.x = 0.24;
        armL.rotation.x = -1.4;
        armR.rotation.x = -1.4;
        legL.rotation.x = 0.35;
        legR.rotation.x = -0.2;
        break;
      case "throw":
        this.body.rotation.y = -0.5;
        armR.rotation.x = -2.5;
        armL.rotation.x = -0.9;
        legL.rotation.x = 0.3;
        break;
      case "catch":
        armL.rotation.x = -2.2;
        armR.rotation.x = -2.2;
        this.body.rotation.x = -0.1;
        break;
      case "kick":
        legR.rotation.x = -1.5;
        legL.rotation.x = 0.2;
        armL.rotation.x = -0.8;
        armR.rotation.x = 0.5;
        this.body.rotation.x = -0.15;
        break;
      case "tackle":
        this.body.rotation.x = 0.55;
        armL.rotation.x = -1.7;
        armR.rotation.x = -1.7;
        legL.rotation.x = 0.5;
        break;
      case "tackled":
        /*
         * Face down on the turf, not standing at an angle.
         *
         * The lift is small and that is not a mistake. Rotating -90° about x
         * maps each part's height to its depth, so the body is already lying at
         * ground level once it turns — it needs raising by half its thickness,
         * not by its standing height. Offsetting by the latter buries him a
         * yard and a third under the field, which is invisible from the
         * sideline camera and obvious the moment anyone looks from the end zone.
         */
        this.body.rotation.x = -Math.PI / 2;
        this.body.position.y = 0.26;
        this.body.position.z = 0.35;
        break;
      case "kneel":
        this.body.position.y = -0.5;
        legR.rotation.x = 1.5;
        legL.rotation.x = 0.4;
        break;
      case "celebrate": {
        const bounce = Math.abs(Math.sin(phase * 0.5));
        this.body.position.y = bounce * 0.22;
        armL.rotation.x = -2.7;
        armR.rotation.x = -2.7;
        armL.rotation.z = 0.35;
        armR.rotation.z = -0.35;
        break;
      }
      default:
        break;
    }
  }

  /**
   * Materials and the shadow. The box geometries are shared, so they are NOT
   * disposed here — see `disposeRigGeometries`.
   */
  dispose(): void {
    this.primary.dispose();
    this.secondary.dispose();
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.Material).dispose();
  }
}
