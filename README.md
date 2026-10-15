# Bridge Load Lab

A model-bridge physics simulator that runs in the browser. Build a truss bridge between two tables, put weights on it, run a load test and watch it hold or collapse. When the test ends you get a report of the weak points.

All lengths are in centimetres. Every member is cut from the same piece: by default a 1 × 1 cm balsa stick, up to 30 cm long. You can change it in the Piece panel.

The bridge is built like a real stick model: two identical side trusses (front and back) joined across the deck. Draw the truss in the **Side view**; switch to the **Top view** to add the cross pieces and bracing that join the two trusses, and to place weights anywhere across the deck.

## Run it

No build step and no dependencies.

- **Quickest:** open `index.html` in a browser.
- **Or serve it:** `npx http-server .` and then open http://localhost:8080.

Your design autosaves in the browser.

## How to use it

Switch views with the **Side view / Top view** buttons or `T`.

| Tool | Key | Side view | Top view |
| --- | --- | --- | --- |
| Build | `B` | Drag from point to point to add a truss member (used for both trusses). Start or end anywhere along an existing beam to glue onto it. Joints on the tables become anchors. | Pick a height in the Height bar, then drag from one truss to the other to add a cross piece or diagonal brace. Start or end anywhere along a chord to glue onto it. |
| Select | `V` | Drag joints or weights. Glued joints slide along their beam. Click a member to see its length and limits. | Click a piece, joint or weight to inspect it. Drag weights across the deck. |
| Weight | `W` | Click a joint or beam. The weight sits in the middle of the deck, shared by both trusses. | Click a cross piece, brace or joint to put the weight exactly there. Off-centre weights load one truss more. |
| Anchor | `A` | Pin a joint down, or release it. Anchors must sit on a table, the floor or the support block. | Not used (anchors come from the side view). |
| Erase | `E` | Click or drag across parts to delete them. | Deletes top-view pieces and weights. |

- **Gluing onto a beam:** when the cursor is near a beam but not a joint, the end snaps onto the beam (to the nearest 0.5 cm along it with grid snap on, and the preview shows the distance). The beam is **not split**: it stays one stick, the new joint (drawn as a diamond) rides on it, and whatever is attached there bends the beam.
- **Joint angles:** every joint shows the angles between neighbouring members, in both views. The preview shows a new piece's angle from horizontal, and the joint panel lists its angles. Turn the arcs off with "Show joint angles".
- **Piece:** pick the material (balsa, basswood, birch craft stick, pine, dry spaghetti, aluminium or steel) and set the width, thickness and maximum length in cm. The panel shows the piece's tension limit, push limit and mass per cm. Members longer than one piece are drawn dashed red and flagged in the report.
- **Run the test:** `Enter`. `Esc` stops it.
- **Undo / redo:** `Ctrl+Z` / `Ctrl+Shift+Z`.
- **Pan:** right-drag, space+drag, or two fingers.
- **Zoom:** scroll wheel or pinch.

The Site section sets the gap between the tables (20–120 cm), the deck width between the two trusses (default 8 cm), adds an optional support block in the middle, and loads starter designs, each with top-view bracing: Pratt, Warren, deck arch, towers and stays, and a plain deck that fails on purpose. The grid is 1 cm, with labelled rulers every 10 cm. "Live stress preview" colours members by utilisation while you edit. "Design code" lets you copy a design and paste it back in later.

## What the report shows

- **Verdict:** Held, Damaged (members broke but the weight stayed up), Collapsed, or Unstable (the structure can't hold its shape).
- **Peak utilisation:** how close the most stressed member came to its limit.
- **Estimated capacity:** the weight (kg) at which the first member would fail.
- **Static sag:** how far the deck deflects under the weight, in cm.
- **Weak points:** the six most stressed pieces (front truss, back truss or top view), each with its failure mode and a suggested fix. They are marked with numbered badges in both views; click one in the list to find it.
- **Failure sequence:** which members broke, in order, with the time and the share of the load applied.
- **Tips:** design-level advice, such as joints that can swing freely, members longer than one piece, too much sag (beyond the usual L/250 limit), and members doing almost nothing.

Hover any member to see its force, limit and utilisation. "Final state" shows the bridge as the test left it.

## The physics

Lengths are shown in cm, masses in kg or g, and forces in newtons. Internally the solvers work in SI units.

Each piece is treated as a solid rectangle. Width lies in the plane of the bridge and thickness is out of plane. Buckling uses the weakest axis, `I = b·h³/12`. Bending uses the in-plane section modulus, `S = t·w²/6`. Material strengths are typical published values, so treat the results as estimates: glue joints, knots and grain direction make real models vary.

Joints are pins, so members carry only axial force. The one exception is a weight resting between two joints, which also bends the piece under it.

- **Two trusses:** each side truss is solved in its own plane. A weight placed in the side view is split 50/50; a weight placed in the top view is split by where it sits across the deck (a weight 20% of the way from the front truss puts 80% on the front).
- **Glued joints:** a joint glued part-way along a beam follows the beam exactly (at fraction t, it sits at (1 − t)·a + t·b). The force it passes in is split into a part across the beam, which bends it like a weight would, and a part along it, which changes the push or pull on either side of the joint; every stretch of the beam is checked. The whole beam length counts for buckling, because one glued joint does not reliably brace it.
- **Top-view pieces** carry weights across the deck by bending (they lie flat, so thickness is the bending depth) and brace the trusses sideways.
- **Sideways buckling:** a compression chord can bow out of its truss plane over the distance between braced joints. A joint counts as braced if the top-view pieces and chords at its height form a rigid (triangulated) frame seen from above. Cross pieces alone form rectangles that can shift, so they don't brace. Joints joined straight to an anchor (the end posts) are treated as braced, assuming the glued end frames are stiff enough to carry bracing forces to the supports.

- **Static analysis** (`js/statics.js`): uses the direct stiffness method. Self weight and the placed weights are solved separately, so the live load can be scaled to find the capacity. Cables that would go into compression are switched off one by one until the solution is consistent. A singular stiffness matrix means a mechanism, and the joint that can move is flagged.
- **Dynamic test** (`js/physics.js`): steps the bridge 200–800 times per frame. Each member is a spring that obeys Hooke's law exactly (`F = EA·ΔL/L`, with a dashpot to calm vibration), so redundant structures share force the same way as in the static solver. Weights hang on hard position constraints. Joint inertia is raised where needed to keep the stiff springs stable; gravity acts only on the real mass. Self weight comes on first. The weights then ramp up over 2 s, and a member is removed as soon as it reaches 100% utilisation.
- **Member check** (`js/core.js`): `u = |N| / N_cap + M / M_cap`.
  - Tension limit: `ft·A`.
  - Compression limit: `min(fc·A, π²EI/L²)`, the lower of crushing and Euler buckling.
  - Bending limit: `fb·S`.

The test suite checks the two solvers against each other: on a Pratt truss, the forces in the dynamic test match the static solution to within 2%, an overloaded truss breaks within 10% of the static capacity estimate, removing the top bracing makes the top chord fail sideways at well under half the load, and a cross piece overloaded in bending breaks within 10% of its predicted load, a redundant (statically indeterminate) truss and a truss with a glued-on brace match the static forces to within 2%, and a beam bent by a glued joint breaks within 10% of its predicted load.

```
node test/physics.test.js
```
