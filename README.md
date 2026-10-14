# Bridge Load Lab

A bridge physics simulator that runs in the browser. Build a truss bridge across a gap, put weights on it, run a load test and watch it hold or collapse. When the test ends you get a report of the weak points.

## Run it

No build step and no dependencies.

- **Quickest:** open `index.html` in a browser.
- **Or serve it:** `npx http-server .` and then open http://localhost:8080.

Your design autosaves in the browser.

## How to use it

| Tool | Key | What it does |
| --- | --- | --- |
| Build | `B` | Drag from point to point to add a member. Joints placed on the cliffs become anchors. |
| Select | `V` | Drag joints or weights. Click a member to see its limits or change its material. |
| Weight | `W` | Click a joint or a beam to place a weight of the mass in the Weight box. |
| Anchor | `A` | Pin a joint to the ground, or release it. Anchors must sit on the cliffs or the pier. |
| Erase | `E` | Click or drag across parts to delete them. |

- **Materials (`1`–`4`):** timber, steel tube, steel I-beam, steel cable (tension only).
- **Run the test:** `Enter`. `Esc` stops it.
- **Undo / redo:** `Ctrl+Z` / `Ctrl+Shift+Z`.
- **Pan:** right-drag, space+drag, or two fingers.
- **Zoom:** scroll wheel or pinch.

The Site section sets the gap width (8–40 m), adds an optional mid-river pier, and loads starter designs: Pratt, Warren, deck arch, cable-stayed, and a plain deck that fails on purpose. "Live stress preview" colours members by utilisation while you edit. "Design code" lets you copy a design and paste it back in later.

## What the report shows

- **Verdict:** Held, Damaged (members broke but the weight stayed up), Collapsed, or Unstable (the structure can't hold its shape).
- **Peak utilisation:** how close the most stressed member came to its limit.
- **Estimated capacity:** the weight at which the first member would fail.
- **Static sag:** how far the deck deflects under the weight.
- **Weak points:** the six most stressed members, each with its failure mode and a suggested fix. They are also marked with numbered badges on the drawing.
- **Failure sequence:** which members broke, in order, with the time and the share of the load applied.
- **Tips:** design-level advice, such as joints that can swing freely, slack cables, too much sag (beyond the usual L/250 limit), and members doing almost nothing.

Hover any member to see its force, limit and utilisation. "Final state" shows the bridge as the test left it.

## The physics

Joints are pins, so members carry only axial force. The one exception is a weight resting between two joints, which also bends the beam under it.

- **Static analysis** (`js/statics.js`): uses the direct stiffness method. Self weight and the placed weights are solved separately, so the live load can be scaled to find the capacity. Cables that would go into compression are switched off one by one until the solution is consistent. A singular stiffness matrix means a mechanism, and the joint that can move is flagged.
- **Dynamic test** (`js/physics.js`): uses small-step XPBD with 160 substeps per frame. Each member is a distance constraint with compliance `L / (E·A)`, so the constraint impulse is the real axial force. Self weight comes on first. The weights then ramp up over 2 s, and a member is removed as soon as it reaches 100% utilisation.
- **Member check** (`js/core.js`): `u = |N| / N_cap + M / M_cap`.
  - Tension limit: `fy·A`.
  - Compression limit: `min(fy·A, π²EI/L²)`, the lower of crushing and Euler buckling.
  - Bending limit: `fy·S`.

The test suite checks the two solvers against each other: on a Pratt truss, the forces in the dynamic test match the static solution to within 0.2%.

```
node test/physics.test.js
```
