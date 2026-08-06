/*
 * The player rig.
 *
 * Unusually for a graphics file, this is testable in Node: a `PlayerRig` is
 * geometry and a transform tree, with no canvas, no renderer and no context.
 * Only `FootballScene` needs a browser, so the thing with the arithmetic in it
 * — the LOD ladder, the pose transforms, the shared-geometry cache — can be
 * checked the same way the choreographer is.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { PlayerRig, disposeRigGeometries, type RigTier } from "../rig.js";
import { PlayerActor } from "../scene.js";
import type { ActorClip } from "../animation.js";

const COLORS = { primary: 0x1d3f8f, secondary: 0xf2f4f8 };
const TIERS: RigTier[] = ["low", "medium", "hero"];
const CLIPS: ActorClip[] = [
  "stance",
  "run",
  "backpedal",
  "block",
  "throw",
  "catch",
  "kick",
  "tackle",
  "tackled",
  "getup",
  "celebrate",
  "kneel",
];

afterEach(() => {
  disposeRigGeometries();
});

describe("levels of detail", () => {
  it("costs strictly more the closer you look", () => {
    const rig = new PlayerRig(COLORS, "low");
    const counts = TIERS.map((tier) => {
      rig.setTier(tier);
      return rig.triangleCount();
    });
    expect(counts[0]).toBeLessThan(counts[1]);
    expect(counts[1]).toBeLessThan(counts[2]);
    rig.dispose();
  });

  it("stays cheap enough to draw twenty-two of", () => {
    /*
     * The budget that matters: a full formation at the most expensive tier. If
     * the hero rig cannot afford twenty-two instances there is no point having
     * a distant tier at all — the near one would already have blown the frame.
     */
    const rig = new PlayerRig(COLORS, "hero");
    expect(rig.triangleCount() * 22).toBeLessThan(20_000);
    rig.dispose();
  });

  it("goes back down as well as up", () => {
    const rig = new PlayerRig(COLORS, "hero");
    const hero = rig.triangleCount();
    rig.setTier("low");
    expect(rig.triangleCount()).toBeLessThan(hero);
    rig.setTier("hero");
    // Rebuilt, not merely hidden — the same count it started with.
    expect(rig.triangleCount()).toBe(hero);
    rig.dispose();
  });

  it("reports the tier it is actually drawing", () => {
    const rig = new PlayerRig(COLORS, "medium");
    expect(rig.currentTier()).toBe("medium");
    rig.setTier("low");
    expect(rig.currentTier()).toBe("low");
    rig.dispose();
  });
});

describe("geometry sharing", () => {
  it("does not allocate a fresh box per player", () => {
    /*
     * Twenty-two players are the same handful of shapes. Counting distinct
     * geometry objects rather than trusting the cache, because a cache that
     * silently stopped hitting would show up only as a memory graph nobody is
     * looking at.
     */
    const rigs = Array.from({ length: 22 }, () => new PlayerRig(COLORS, "hero"));
    const geometries = new Set<THREE.BufferGeometry>();
    let meshes = 0;
    for (const rig of rigs) {
      rig.group.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          meshes++;
          geometries.add(object.geometry);
        }
      });
    }
    expect(meshes).toBeGreaterThan(300);
    // The shadow circle is per-actor; the boxes are not.
    expect(geometries.size).toBeLessThan(40);
    for (const rig of rigs) rig.dispose();
  });
});

describe("poses", () => {
  it("has a pose for every clip the choreographer can emit", () => {
    // A clip with no pose is not a crash — it is a man standing still through
    // his own touchdown, which is exactly the kind of thing nobody notices.
    const rig = new PlayerRig(COLORS, "medium");
    for (const clip of CLIPS) {
      rig.pose(clip, 0);
      const moved =
        rig.body.rotation.x !== 0 ||
        rig.body.rotation.y !== 0 ||
        rig.body.position.y !== 0 ||
        Object.values(rig.limbs).some((limb) => limb.rotation.x !== 0);
      expect(moved, `${clip} has no pose`).toBe(true);
    }
    rig.dispose();
  });

  it("rises through getup, rather than popping upright", () => {
    // The middle of three poses: lower than standing, higher than prone. If it
    // matched either neighbour the transition would still be a pop.
    const rig = new PlayerRig(COLORS, "medium");
    const heightIn = (clip: ActorClip) => {
      rig.pose(clip, 0);
      rig.group.updateMatrixWorld(true);
      return new THREE.Box3().setFromObject(rig.group).max.y;
    };
    const prone = heightIn("tackled");
    const rising = heightIn("getup");
    const standing = heightIn("stance");
    expect(rising).toBeGreaterThan(prone);
    expect(rising).toBeLessThan(standing);
    rig.dispose();
  });

  it("puts a tackled player on the ground, and on top of it", () => {
    /*
     * Measured from the geometry rather than the transform. Asserting the
     * internal offset is how the first version of this test passed while the
     * player was buried a yard under the turf: rotating -90° about x already
     * lays the body flat, so the standing-height offset that looks right in the
     * source is one the bounding box immediately contradicts.
     */
    const rig = new PlayerRig(COLORS, "medium");
    rig.pose("tackled", 0);
    rig.group.updateMatrixWorld(true);
    const prone = new THREE.Box3().setFromObject(rig.group);

    rig.pose("run", 0);
    rig.group.updateMatrixWorld(true);
    const upright = new THREE.Box3().setFromObject(rig.group);

    expect(prone.max.y).toBeLessThan(upright.max.y / 2);
    expect(prone.min.y).toBeGreaterThan(-0.1);
    rig.dispose();
  });

  it("swings opposite arm to opposite leg when running", () => {
    // The one thing the eye actually checks in a running figure.
    const rig = new PlayerRig(COLORS, "medium");
    rig.pose("run", Math.PI / 2);
    expect(Math.sign(rig.limbs.legL.rotation.x)).toBe(-Math.sign(rig.limbs.legR.rotation.x));
    expect(Math.sign(rig.limbs.armL.rotation.x)).toBe(-Math.sign(rig.limbs.legL.rotation.x));
    rig.dispose();
  });

  it("moves the legs through the gait as the phase advances", () => {
    const rig = new PlayerRig(COLORS, "medium");
    rig.pose("run", 0);
    const atZero = rig.limbs.legL.rotation.x;
    rig.pose("run", Math.PI / 2);
    expect(rig.limbs.legL.rotation.x).not.toBeCloseTo(atZero, 3);
    rig.dispose();
  });

  it("leaves no residue from the pose before it", () => {
    /*
     * Every pose resets the whole skeleton first. Without that, a player who
     * threw a pass and then ran would run with his arm still cocked — the
     * classic bug of poses that only set the joints they care about.
     */
    const rig = new PlayerRig(COLORS, "medium");
    rig.pose("throw", 0);
    expect(rig.limbs.armR.rotation.x).not.toBe(0);
    rig.pose("stance", 0);
    const afterThrow = rig.limbs.armR.rotation.x;

    const fresh = new PlayerRig(COLORS, "medium");
    fresh.pose("stance", 0);
    expect(afterThrow).toBe(fresh.limbs.armR.rotation.x);
    rig.dispose();
    fresh.dispose();
  });

  it("keeps every player inside his own space, in every pose and tier", () => {
    const rig = new PlayerRig(COLORS, "hero");
    for (const tier of TIERS) {
      rig.setTier(tier);
      for (const clip of CLIPS) {
        rig.pose(clip, 1.1);
        rig.group.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(rig.group);
        // Roughly a yard either side and never through the turf: a player who
        // sank below zero would be visibly buried in the field.
        expect(bounds.min.y, `${tier}/${clip}`).toBeGreaterThan(-0.35);
        expect(bounds.max.y, `${tier}/${clip}`).toBeLessThan(2.6);
        expect(bounds.max.x - bounds.min.x, `${tier}/${clip}`).toBeLessThan(2.4);
      }
    }
    rig.dispose();
  });
});

describe("colours", () => {
  it("repaints in place, because slots change hands every play", () => {
    const rig = new PlayerRig(COLORS, "medium");
    rig.setColors({ primary: 0xb3272d, secondary: 0x1b1b1f });
    const seen = new Set<number>();
    rig.group.traverse((object) => {
      if (object instanceof THREE.Mesh && "color" in object.material) {
        seen.add((object.material as THREE.MeshLambertMaterial).color.getHex());
      }
    });
    expect(seen.has(0xb3272d)).toBe(true);
    expect(seen.has(0x1b1b1f)).toBe(true);
    expect(seen.has(COLORS.primary)).toBe(false);
    rig.dispose();
  });
});

describe("PlayerActor", () => {
  it("drops detail with distance from the camera", () => {
    /*
     * Tier selection lives with the actor, not the choreographer — which does
     * not know a camera exists and must not, or the layout would depend on
     * where someone was looking and a replay would stop being reproducible.
     */
    const actor = new PlayerActor({ primary: 0x111111, secondary: 0x222222 });
    // Where the broadcast camera really sits: high, and off the near sideline.
    const camera = new THREE.Vector3(0, 30, 46);

    // Positions a player actually occupies, not abstract distances — the
    // thresholds were wrong the first time precisely because they were picked
    // without reference to the camera being thirty yards in the air.
    const tierAt = (x: number, z: number) => {
      actor.place(x, 0, z, 0);
      actor.updateTier(camera);
      return actor.tier();
    };

    expect(tierAt(0, 25)).toBe("hero"); // near sideline, on the ball
    expect(tierAt(0, 0)).toBe("medium"); // midfield
    expect(tierAt(0, -25)).toBe("low"); // far sideline
    expect(actor.triangleCount()).toBeLessThan(200);
    actor.dispose();
  });

  it("advances the gait by distance run, not by the clock", () => {
    /*
     * The classic bug this avoids: twenty-two men jogging on the spot between
     * snaps. Tying the cycle to distance also makes it correct at 6x speed,
     * where a clock-driven gait would sprint.
     */
    const actor = new PlayerActor({ primary: 0x111111, secondary: 0x222222 });
    const legOf = () => {
      actor.refresh();
      return (actor as unknown as { rig: PlayerRig }).rig.limbs.legL.rotation.x;
    };

    actor.place(0, 0, 0, 0);
    actor.setClip("run");
    const standing = legOf();

    // Standing still: same spot, same legs.
    actor.place(0, 0, 0, 0);
    expect(legOf()).toBe(standing);

    // Actually running: the legs move.
    actor.place(3, 0, 0, 0);
    expect(legOf()).not.toBe(standing);
    actor.dispose();
  });
});
