# Synaptic field

An animated synaptic-firing layer that runs **on the actual geometry of a neuron
micrograph** — not decorative particles drawn on top of it.

## Files

| file | what it is |
|---|---|
| `synapse-field.js` | the engine (`window.SynapseField`), no dependencies |
| `synapse-field.css` | the three stacked layers + interaction cursors |
| `neuronmap-data.js` | both micrographs inlined as data URIs (`window.ECHO_NEURON_IMAGES`) |
| `synapse.html` | standalone demo: state buttons, stats, view controls |

The images are inlined because a canvas that reads pixels from a `file://` image
is tainted — Electron would refuse `getImageData`, which the whole build needs.

## How it works

At load (0.5–1.5 s, once):

1. the micrograph is read back pixel by pixel;
2. tissue is separated from background by luminance;
3. dotted neurites are closed by a box dilation, then **Zhang-Suen thinning**
   reduces every neurite to a one-pixel centreline;
4. the skeleton is traced into **fibres** joined at branch nodes — branches are
   found by crossing number, not neighbour count, so a diagonal staircase does
   not fake a junction every few pixels and long axons stay whole;
5. free endings that nearly touch are wired together as **synapses**;
6. **cell bodies** are peaks of brightness density, each bound to a fibre node.

At runtime a spike is a set of impulses. An impulse is a short bright bead
running down a **route** — a path assembled at spike time by always taking the
straightest continuation through each junction, optionally biased toward a
distant cell so long projections keep crossing the field. Each fibre has a
refractory period (which is what stops signals circling in the dense mesh), the
bead's colour is sampled from the photograph underneath it, and terminals flash
when the impulse arrives.

## States

`idle` · `listening` · `thinking` · `speaking` · `acting` — rate, conduction
velocity, branch probability, reach, bead length and glow all cross-fade between
them over ~300 ms.

```js
const f = new SynapseField({ host: el, imageSrc: ECHO_NEURON_IMAGES.dense,
                             threshold: 46, closeR: 1 });
await f.ready;
f.setState('thinking');
f.setLevel(0.7);   // voice amplitude — drives listening/speaking
f.burst();         // one-off cascade
```

Per-image build options: `threshold`, `minSat`, `closeR`, `bridgeR`, `somaCut`,
`somaR`, `somaNMS`, `colourLock`, `branchScale`, `reachScale`.

The two maps need genuinely different masks. The cluster image is thin and
dotted on true black (24% of pixels are tissue at `threshold: 26`), so it wants
closing. The dense reconstruction is a solid slab — at `threshold: 46` **half of
every pixel in the frame** counts as tissue, and its skeleton degenerates into a
mesh of 10px stubs that no signal can travel along. It needs a chroma mask
(`minSat`) to keep the vivid cells and drop the grey haze between them:

```js
dense:   { threshold: 60, minSat: 40, closeR: 2, bridgeR: 8, somaCut: 0.07,
           somaR: 10, somaNMS: 28, colourLock: 1.5, branchScale: 0.45, reachScale: 1.8 }
cluster: { threshold: 26, minSat: 0,  closeR: 2, bridgeR: 9, somaCut: 0.045,
           somaR: 9,  somaNMS: 26, colourLock: 0.9 }
```

`colourLock` is what keeps a signal on one cell: in both micrographs colour *is*
cell identity, so at a crossing the route prefers the continuation whose hue
matches the fibre it arrived on. Colours are drawn at full chroma (stretched
between the pixel's min and max channel), otherwise pale fibres fire white.

## View

Scroll = zoom about the cursor · drag = pan · shift-drag or two-finger twist =
rotate through 360° · double-click = reset. Also `zoomBy()`, `rotateBy()`,
`resetView()`, and `onview` for a read-out.

## Cost

~0.9–1.7 ms per frame with 120–270 impulses live, 60 fps. `requestAnimationFrame`
pauses when the window is hidden, so a background HUD costs nothing.

## Where it runs in Echo

**Neural Core window** (`renderer/neural.html` + `neural.js`, opened by
`show_neural_core` or the panel's Neural Map button) — full size, full quality,
interactive, both micrographs (◍ switches). It listens to the same `state` and
`level` IPC the reactor does, via `forwardToNeural()` in `src/neural.ts`, so the
firing rate *is* Echo's state rather than a decoration of it.

**Control panel card** (`.neural-card`, under Live Activity) — the dense map at
`buildScale: 0.6`, `fxScale: 0.6`, `impulseCap: 120`, `fps: 30`, `zoom: 1.4`,
non-interactive.

### Keeping it free

Steady state, measured inside the real control panel: **0 frames over 20ms**,
16.57ms average with the field running against 16.59ms with it stopped — no
measurable cost.

The build is the part that needed care. Done in one go it blocks a frame, and
the panel's own watchdog caught it in a live session as a **793ms dropped
frame**. With `chunked: true` every heavy loop hands the thread back when its
slice (`sliceMs`, 4ms) is spent, so the worst synchronous gap is now **22ms** —
under one 60fps frame, and well under the 50ms the watchdog reports. The build
also waits 1.5s after the panel opens, because the panel's own bootstrap
already costs ~99ms of worst-case frame time and the two should not overlap.

What buys the rest:

- `buildScale` analyses a downscaled copy. Every build step is per-pixel, so
  0.6 scale is ~a third of the work and the memory. Quality does not drop with
  it: conduction velocity, bead length, reach, soma radius and bridging distance
  are all quoted in full-resolution pixels and scaled to the build, so routes
  come out the same length (~270px median at 0.6 vs ~350 at full) and the
  animation looks the same, just smaller.
- `fps` caps the card at 30fps — 0.4ms of work per real frame.
- The build (~440ms wall clock at 0.6, spread across frames) runs in
  `requestIdleCallback` after a settle delay, so opening the panel never waits
  for it and never stutters because of it.
- It stops whenever it cannot be seen: another view, a hidden document. Electron
  pauses `requestAnimationFrame` for a hidden window on its own.
- Build-only buffers (`lit`, `bright`, `skel`, `branch`) are released once the
  geometry exists; only the pixel data stays, for impulse colour (~2MB).
