/*
 * SynapseField — action potentials travelling on the real geometry of a
 * neuron micrograph.
 *
 * Build pipeline (once, at load):
 *   1. read the image back pixel by pixel
 *   2. threshold tissue vs. background
 *   3. Zhang-Suen thinning  -> one-pixel-wide centrelines of every neurite
 *   4. trace the skeleton into fibres (polylines) joined at branch nodes
 *   5. find cell bodies as peaks of brightness density, bind each to a node
 *
 * Runtime: a spike is a set of impulses. An impulse is a short bright bead
 * running along ONE fibre at a fixed conduction velocity. At a branch node it
 * continues (and sometimes splits) after a synaptic delay, loses amplitude,
 * and eventually dies; at a free ending it flashes once, like a bouton.
 * Everything is drawn in the fibre's own colour, taken from the photograph.
 *
 * Layers appended to the host element:
 *   img.sf-base     the micrograph
 *   canvas.sf-glow  blurred copy of the FX layer   (screen)
 *   canvas.sf-fx    impulses + afterglow trail     (screen)
 *
 *   const f = new SynapseField({ host });
 *   await f.ready;
 *   f.setState('thinking');   // idle | listening | thinking | speaking | acting
 *   f.setLevel(0..1);         // voice amplitude, drives listening / speaking
 *   f.burst();
 */
(function (global) {
  'use strict';

  var STATES = {
    // rate   spikes per second          speed  conduction velocity, px/s
    // branch chance a junction splits   atten  amplitude kept per junction
    // bead   length of the depolarised zone, px
    idle: {
      rate: 2.0, speed: 260, branch: 0.26, atten: 0.88, bead: 60, reach: 700,
      amp: 0.66, core: 0.12, twinkle: 4, soma: 0.5, fade: 0.032, base: 1.0
    },
    listening: {
      rate: 5.0, speed: 330, branch: 0.34, atten: 0.90, bead: 70, reach: 1100,
      amp: 0.78, core: 0.14, twinkle: 9, soma: 0.65, fade: 0.036, base: 1.02
    },
    thinking: {
      rate: 14.0, speed: 470, branch: 0.48, atten: 0.92, bead: 85, reach: 2000,
      amp: 0.92, core: 0.19, twinkle: 20, soma: 0.8, fade: 0.045, base: 1.05
    },
    speaking: {
      rate: 12.0, speed: 500, branch: 0.44, atten: 0.92, bead: 80, reach: 1800,
      amp: 0.9, core: 0.18, twinkle: 18, soma: 0.78, fade: 0.045, base: 1.04
    },
    acting: {
      rate: 30.0, speed: 720, branch: 0.62, atten: 0.94, bead: 100, reach: 3400,
      amp: 1.05, core: 0.24, twinkle: 42, soma: 1.0, fade: 0.055, base: 1.08
    }
  };

  var LUM_THRESHOLD = 26;     // tissue vs. background
  var CLOSE_R = 2;            // px — closes the gaps in dotted neurites before thinning
  var BRIDGE_R = 9;           // px — free endings this close are treated as a synapse
  var MIN_SEG = 6;   // px (scaled by buildScale below)            // px — shorter fragments are noise
  var MAX_IMPULSES = 1600;
  var SEG_REFRACTORY = 0.30;  // s — a fibre cannot carry a second impulse yet,
                              // which is what stops the signal running in circles
  var SYN_DELAY = 0.012;      // s — held at a branch node before continuing

  function lerp(a, b, k) { return a + (b - a) * k; }

  /**
   * The build is per-pixel work measured in hundreds of milliseconds, and doing
   * it in one go blocks a frame — the control panel's own watchdog caught it as
   * a 793ms dropped frame. Every heavy loop calls this and hands the thread
   * back whenever its slice is spent, so the build costs many small frames
   * instead of one long stall.
   */
  SynapseField.prototype._slice = function () {
    if (!this.opt.chunked) return null;
    var now = performance.now();
    if (now - this._sliceAt < this.opt.sliceMs) return null;
    var self = this;
    return new Promise(function (res) {
      requestAnimationFrame(function () { self._sliceAt = performance.now(); res(); });
    });
  };

  function SynapseField(opts) {
    opts = opts || {};
    this.host = opts.host;
    this.imageSrc = opts.imageSrc || global.ECHO_NEURON_IMAGE || '';
    this.state = opts.state || 'idle';
    this.opt = {
      threshold: opts.threshold != null ? opts.threshold : LUM_THRESHOLD,
      closeR: opts.closeR != null ? opts.closeR : CLOSE_R,
      bridgeR: opts.bridgeR != null ? opts.bridgeR : BRIDGE_R,
      somaCut: opts.somaCut != null ? opts.somaCut : 0.045,
      somaR: opts.somaR != null ? opts.somaR : 9,
      somaNMS: opts.somaNMS != null ? opts.somaNMS : 26,
      minSat: opts.minSat != null ? opts.minSat : 0,
      colourLock: opts.colourLock != null ? opts.colourLock : 0.9,
      branchScale: opts.branchScale != null ? opts.branchScale : 1,
      reachScale: opts.reachScale != null ? opts.reachScale : 1,
      // A small panel renders its FX layers at a fraction of the image size:
      // the simulation is unchanged, only the canvas it paints into shrinks.
      fxScale: opts.fxScale != null ? opts.fxScale : 1,
      impulseCap: opts.impulseCap != null ? opts.impulseCap : MAX_IMPULSES,
      interactive: opts.interactive !== false,
      // A small card analyses a downscaled copy of the micrograph: thinning and
      // tracing are per-pixel, so half size is a quarter of the build cost and
      // a quarter of the memory held afterwards.
      buildScale: opts.buildScale != null ? opts.buildScale : 1,
      fps: opts.fps != null ? opts.fps : 0,       // 0 = display rate
      zoom: opts.zoom != null ? opts.zoom : 1,    // starting magnification
      // Build in slices, yielding to the browser between them, so a panel that
      // is also rendering never drops a frame to it.
      chunked: opts.chunked === true,
      sliceMs: opts.sliceMs != null ? opts.sliceMs : 4   // keep every slice inside one 60fps frame
    };
    this.level = 0;
    this.running = false;
    this.impulses = [];
    this.flashes = [];
    this.somaFlashes = [];
    this.spikeAcc = 0;
    this.twinkleAcc = 0;
    this.time = 0;
    this.p = Object.assign({}, STATES[this.state]);
    this.target = STATES[this.state];
    this.stats = { spikes: 0, active: 0, fps: 0, fibres: 0, somas: 0 };
    this.heatW = 12; this.heatH = 7;
    this.heat = new Float32Array(this.heatW * this.heatH);
    this.ready = this._build();
  }

  SynapseField.prototype._build = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        // let the page paint before the (heavy) one-off geometry pass
        setTimeout(function () {
          Promise.resolve()
            .then(function () { return self._init(img); })
            .then(function () { resolve(self); }, reject);
        }, 16);
      };
      img.onerror = function () { reject(new Error('neuron image failed to load')); };
      img.src = self.imageSrc;
    });
  };

  // ======================================================================
  // geometry
  // ======================================================================
  SynapseField.prototype._init = async function (img) {
    var t0 = performance.now();
    this._sliceAt = t0;
    var bs = this.opt.buildScale;
    var W = this.W = Math.round(img.naturalWidth * bs);
    var H = this.H = Math.round(img.naturalHeight * bs);
    var n = W * H;

    var off = document.createElement('canvas');
    off.width = W; off.height = H;
    var octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(img, 0, 0, W, H);
    var px = this.px = octx.getImageData(0, 0, W, H).data;

    var lit = new Uint8Array(n), bright = new Uint8Array(n);
    var minSat = this.opt.minSat;
    for (var i = 0, o = 0; i < n; i++, o += 4) {
      var r0 = px[o], g0 = px[o + 1], b0 = px[o + 2];
      var l = (r0 * 77 + g0 * 150 + b0 * 29) >> 8;
      bright[i] = l;
      if (l < this.opt.threshold) continue;
      // On a dense reconstruction every cell has its own hue and the grey haze
      // between them is not tissue we should conduct through: require chroma.
      if (minSat > 0) {
        var mx = r0 > g0 ? (r0 > b0 ? r0 : b0) : (g0 > b0 ? g0 : b0);
        var mn = r0 < g0 ? (r0 < b0 ? r0 : b0) : (g0 < b0 ? g0 : b0);
        if (mx - mn < minSat) continue;
      }
      lit[i] = 1;
    }
    this.lit = lit; this.bright = bright;

    // The neurites in the micrograph are dotted; dilating before thinning
    // reconnects them into continuous fibres.
    this.gs = bs;   // physics is quoted in full-res px; scale it to this build
    var w = this._slice(); if (w) await w;
    var mask = this.opt.closeR > 0 ? await this._dilate(lit, this.opt.closeR) : lit;
    w = this._slice(); if (w) await w;
    this.skel = await this._thin(mask);
    w = this._slice(); if (w) await w;
    await this._trace(this.skel);
    w = this._slice(); if (w) await w;
    this.somas = await this._findSomas(bright);
    await this._bindSomas();

    // Only `px` is needed at run time (impulses take their colour from the
    // photograph); the masks were scaffolding for the build and are dropped.
    this.lit = null; this.bright = null; this.skel = null; this.branch = null;

    this.stats.fibres = this.segs.length;
    this.stats.somas = this.somas.length;
    this.stats.buildMs = Math.round(performance.now() - t0);

    // ---- layers ----------------------------------------------------------
    var host = this.host;
    host.classList.add('sf-host');
    var base = this.base = img;
    base.className = 'sf-base';
    base.draggable = false;

    var fs = this.opt.fxScale;
    var glow = this.glowCanvas = document.createElement('canvas');
    glow.className = 'sf-glow';
    glow.width = Math.max(1, Math.round(W * fs / 2)); glow.height = Math.max(1, Math.round(H * fs / 2));

    var fx = this.fxCanvas = document.createElement('canvas');
    fx.className = 'sf-fx';
    fx.width = Math.round(W * fs); fx.height = Math.round(H * fs);

    var stage = this.stage = document.createElement('div');
    stage.className = 'sf-stage';
    stage.appendChild(base); stage.appendChild(glow); stage.appendChild(fx);
    host.appendChild(stage);
    if (this.opt.interactive) this._controls();
    else { this.view = { x: 0, y: 0, s: 1, r: 0 }; this._apply(); }
    if (this.opt.zoom !== 1) { this.view.s = this.opt.zoom; this._apply(); }
    this.fx = fx.getContext('2d');
    this.glow = glow.getContext('2d');
    this.fx.lineCap = 'round';
    this.fx.lineJoin = 'round';
    // everything below draws in image pixels; the context does the scaling
    if (fs !== 1) this.fx.setTransform(fs, 0, 0, fs, 0, 0);

    this.start();
  };

  // Separable box dilation — cheap morphological closing of the dotted fibres.
  SynapseField.prototype._dilate = async function (src, R) {
    var W = this.W, H = this.H, n = W * H;
    var tmp = new Uint8Array(n), out = new Uint8Array(n);
    for (var y = 0; y < H; y++) {
      if ((y & 127) === 0) { var d0 = this._slice(); if (d0) await d0; }
      var row = y * W;
      for (var x = 0; x < W; x++) {
        var v = 0;
        for (var k = -R; k <= R; k++) {
          var xx = x + k;
          if (xx < 0 || xx >= W) continue;
          if (src[row + xx]) { v = 1; break; }
        }
        tmp[row + x] = v;
      }
    }
    for (var x2 = 0; x2 < W; x2++) {
      if ((x2 & 127) === 0) { var d1 = this._slice(); if (d1) await d1; }
      for (var y2 = 0; y2 < H; y2++) {
        var v2 = 0;
        for (var k2 = -R; k2 <= R; k2++) {
          var yy = y2 + k2;
          if (yy < 0 || yy >= H) continue;
          if (tmp[yy * W + x2]) { v2 = 1; break; }
        }
        out[y2 * W + x2] = v2;
      }
    }
    return out;
  };

  // Zhang-Suen thinning, restricted to the set pixels so it stays fast.
  SynapseField.prototype._thin = async function (lit) {
    var W = this.W, n = W * this.H;
    var s = new Uint8Array(lit);
    var active = [];
    for (var i = W + 1; i < n - W - 1; i++) if (s[i]) active.push(i);

    var kill = [];
    for (var pass = 0; pass < 14; pass++) {
      var changed = 0;
      for (var step = 0; step < 2; step++) {
        var mid = this._slice(); if (mid) await mid;
        kill.length = 0;
        for (var a = 0; a < active.length; a++) {
          var idx = active[a];
          if (!s[idx]) continue;
          var x = idx % W;
          if (x < 1 || x > W - 2) continue;
          var p2 = s[idx - W], p3 = s[idx - W + 1], p4 = s[idx + 1], p5 = s[idx + W + 1],
              p6 = s[idx + W], p7 = s[idx + W - 1], p8 = s[idx - 1], p9 = s[idx - W - 1];
          var B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          var A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) +
                  (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (A !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6) continue;
            if (p4 * p6 * p8) continue;
          } else {
            if (p2 * p4 * p8) continue;
            if (p2 * p6 * p8) continue;
          }
          kill.push(idx);
        }
        for (var k = 0; k < kill.length; k++) { s[kill[k]] = 0; changed++; }
      }
      if (!changed) break;
      var pause = this._slice(); if (pause) await pause;
      var next = [];
      for (var b = 0; b < active.length; b++) if (s[active[b]]) next.push(active[b]);
      active = next;
    }
    return s;
  };

  // Skeleton -> fibres (polylines) joined at nodes.
  //
  // Branch detection uses the crossing number (count of 0->1 transitions round
  // the 8-neighbourhood), not the raw neighbour count: on a diagonal staircase
  // a plain pass-through pixel has three neighbours but only two branches, and
  // counting neighbours shatters every long axon into ~40px fragments.
  SynapseField.prototype._trace = async function (skel) {
    var W = this.W, n = W * this.H;
    var nb = [-W, -W + 1, 1, W + 1, W, W - 1, -1, -W - 1];   // clockwise from N
    var branch = new Uint8Array(n);
    var cells = [];
    var ring = new Uint8Array(8);

    for (var i = W + 1; i < n - W - 1; i++) {
      if (!skel[i]) continue;
      var x = i % W;
      if (x < 1 || x > W - 2) continue;
      var cnt = 0;
      for (var j = 0; j < 8; j++) { ring[j] = skel[i + nb[j]] ? 1 : 0; cnt += ring[j]; }
      var trans = 0;
      for (var t = 0; t < 8; t++) if (!ring[t] && ring[(t + 1) & 7]) trans++;
      branch[i] = cnt === 1 ? 1 : (trans || (cnt === 8 ? 4 : 1));
      cells.push(i);
    }
    this.skelCells = new Int32Array(cells);
    this.branch = branch;

    var nodeOf = new Int32Array(n).fill(-1);
    var nodes = [];
    for (var c = 0; c < cells.length; c++) {
      var ci = cells[c];
      if (branch[ci] !== 2) { nodeOf[ci] = nodes.length; nodes.push({ i: ci, segs: [] }); }
    }

    function adjacent(a, b) {
      var ax = a % W, ay = (a / W) | 0, bx = b % W, by = (b / W) | 0;
      return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1;
    }

    var segs = [];
    var seen = new Set();
    for (var ni = 0; ni < nodes.length; ni++) {
      if ((ni & 63) === 0) { var brk = this._slice(); if (brk) await brk; }
      var start = nodes[ni].i;
      for (var e = 0; e < 8; e++) {
        var first = start + nb[e];
        if (first < 0 || first >= n || !skel[first]) continue;
        var kk = start < first ? (start + ':' + first) : (first + ':' + start);
        if (seen.has(kk)) continue;
        seen.add(kk);

        var path = [start, first];
        var prev = start, cur = first, guard = 0;
        while (branch[cur] === 2 && guard++ < 1400) {
          var nxt = -1, fallback = -1;
          for (var q = 0; q < 8; q++) {
            var m = cur + nb[q];
            if (m < 0 || m >= n || !skel[m] || m === prev) continue;
            if (adjacent(m, prev)) { if (fallback < 0) fallback = m; continue; }
            nxt = m; break;
          }
          if (nxt < 0) nxt = fallback;
          if (nxt < 0) break;
          seen.add(cur < nxt ? (cur + ':' + nxt) : (nxt + ':' + cur));
          prev = cur; cur = nxt; path.push(cur);
        }
        if (path.length < Math.max(4, MIN_SEG * this.gs) || path.length > 1200) continue;   // >1200 = a cycle in the mesh, not a fibre

        var seg = {
          cells: new Int32Array(path),
          a: nodeOf[start],
          b: nodeOf[cur] >= 0 ? nodeOf[cur] : -1,
          len: path.length,
          col: this._sampleColour(path)
        };
        var id = segs.length;
        segs.push(seg);
        if (seg.a >= 0) nodes[seg.a].segs.push({ s: id, from: 'a' });
        if (seg.b >= 0) nodes[seg.b].segs.push({ s: id, from: 'b' });
      }
    }

    this.nodes = nodes;
    this.segs = segs;
    var pause2 = this._slice(); if (pause2) await pause2;
    this._bridge();
    this.segT = new Float32Array(this.segs.length).fill(-99);
    this._directions();
  };

  // Free endings that nearly touch are wired as synapses: the impulse hops the
  // cleft with an extra delay instead of dying at the end of its own cell.
  SynapseField.prototype._bridge = function () {
    var W = this.W, nodes = this.nodes, segs = this.segs;
    var ends = [];
    for (var i = 0; i < nodes.length; i++) if (nodes[i].segs.length === 1) ends.push(i);

    var BR = Math.max(3, Math.round(this.opt.bridgeR * this.gs)), CELL = BR, buckets = new Map();
    function key(x, y) { return ((y / CELL) | 0) * 100000 + ((x / CELL) | 0); }
    for (var e = 0; e < ends.length; e++) {
      var ci = nodes[ends[e]].i, k = key(ci % W, (ci / W) | 0);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(ends[e]);
    }

    var made = 0, R2 = BR * BR;
    for (var a = 0; a < ends.length; a++) {
      var na = ends[a];
      if (nodes[na].segs.length > 1) continue;
      var ai = nodes[na].i, ax = ai % W, ay = (ai / W) | 0;
      var best = -1, bestD = 1e9;
      for (var gy = -1; gy <= 1; gy++) for (var gx = -1; gx <= 1; gx++) {
        var list = buckets.get(key(Math.max(0, ax + gx * CELL), Math.max(0, ay + gy * CELL)));
        if (!list) continue;
        for (var q = 0; q < list.length; q++) {
          var nbId = list[q];
          if (nbId === na || nodes[nbId].segs.length > 1) continue;
          var bi = nodes[nbId].i, dx = (bi % W) - ax, dy = ((bi / W) | 0) - ay;
          var d = dx * dx + dy * dy;
          if (d > 4 && d < R2 && d < bestD) { bestD = d; best = nbId; }
        }
      }
      if (best < 0) continue;
      var bI = nodes[best].i, bx = bI % W, by = (bI / W) | 0;
      var steps = Math.max(2, Math.round(Math.sqrt(bestD)));
      var path = [];
      for (var t2 = 0; t2 <= steps; t2++) {
        var px2 = Math.round(ax + (bx - ax) * t2 / steps);
        var py2 = Math.round(ay + (by - ay) * t2 / steps);
        path.push(py2 * W + px2);
      }
      var seg = {
        cells: new Int32Array(path), a: na, b: best, len: path.length,
        col: segs[nodes[na].segs[0].s].col, syn: true
      };
      var id = segs.length;
      segs.push(seg);
      nodes[na].segs.push({ s: id, from: 'a' });
      nodes[best].segs.push({ s: id, from: 'b' });
      made++;
    }
    this.stats.synapses = made;
  };

  // Exit direction at each end of a fibre — used to keep a route running
  // straight through a junction instead of turning at random.
  SynapseField.prototype._directions = function () {
    var W = this.W, segs = this.segs;
    for (var i = 0; i < segs.length; i++) {
      var c = segs[i].cells, n = c.length, k = Math.min(n - 1, 9);
      var ax = c[0] % W, ay = (c[0] / W) | 0;
      var ax2 = c[k] % W, ay2 = (c[k] / W) | 0;
      var bx = c[n - 1] % W, by = (c[n - 1] / W) | 0;
      var bx2 = c[n - 1 - k] % W, by2 = (c[n - 1 - k] / W) | 0;
      segs[i].eA = norm(ax - ax2, ay - ay2);     // travelling out through end a
      segs[i].eB = norm(bx - bx2, by - by2);     // travelling out through end b
      segs[i].ax = ax; segs[i].ay = ay; segs[i].bx = bx; segs[i].by = by;
    }
  };

  function norm(x, y) {
    var m = Math.sqrt(x * x + y * y) || 1;
    return [x / m, y / m];
  }

  SynapseField.prototype._sampleColour = function (path) {
    var px = this.px, r = 0, g = 0, b = 0, cnt = 0;
    var step = Math.max(1, (path.length / 12) | 0);
    for (var k = 0; k < path.length; k += step) {
      var o = path[k] * 4;
      r += px[o]; g += px[o + 1]; b += px[o + 2]; cnt++;
    }
    return saturate(r / cnt, g / cnt, b / cnt);
  };

  // Cell bodies: peaks of local brightness, non-max suppressed.
  SynapseField.prototype._findSomas = async function (bright) {
    var W = this.W, H = this.H, W1 = W + 1;
    var integ = new Float64Array(W1 * (H + 1));
    for (var y = 0; y < H; y++) {
      if ((y & 127) === 0) { var brk0 = this._slice(); if (brk0) await brk0; }
      var row = 0;
      for (var x = 0; x < W; x++) {
        row += bright[y * W + x];
        integ[(y + 1) * W1 + (x + 1)] = integ[y * W1 + (x + 1)] + row;
      }
    }
    function box(x0, y0, x1, y1) {
      return integ[y1 * W1 + x1] - integ[y0 * W1 + x1] - integ[y1 * W1 + x0] + integ[y0 * W1 + x0];
    }
    var R = Math.max(3, Math.round(this.opt.somaR * this.gs)), cand = [], maxD = 1, STEP = 2;
    var pause3 = this._slice(); if (pause3) await pause3;
    for (var yy = R; yy < H - R; yy += STEP) {
      if ((yy & 127) === 0) { var brk1 = this._slice(); if (brk1) await brk1; }
      for (var xx = R; xx < W - R; xx += STEP) {
        var d = box(xx - R, yy - R, xx + R + 1, yy + R + 1);
        if (d > maxD) maxD = d;
        if (d > 0) cand.push([d, yy * W + xx]);
      }
    }
    var cut = maxD * this.opt.somaCut;   // low: the isolated cells on the left are dimmer
                             // than the core, and they must still be found
    cand = cand.filter(function (c) { return c[0] > cut; });
    cand.sort(function (p, q) { return q[0] - p[0]; });

    var chosen = [], NMS = Math.max(8, this.opt.somaNMS * this.gs), NMS2 = NMS * NMS;
    var pause4 = this._slice(); if (pause4) await pause4;
    for (var s = 0; s < cand.length && chosen.length < 340; s++) {
      if ((s & 1023) === 0) { var brk2 = this._slice(); if (brk2) await brk2; }
      var idx = cand[s][1], cx = idx % W, cy = (idx / W) | 0, ok = true;
      for (var t = 0; t < chosen.length; t++) {
        var dx = chosen[t].x - cx, dy = chosen[t].y - cy;
        if (dx * dx + dy * dy < NMS2) { ok = false; break; }
      }
      if (!ok) continue;
      var o = idx * 4;
      chosen.push({
        x: cx, y: cy, i: idx, w: cand[s][0] / maxD, cool: 0,
        col: saturate(this.px[o], this.px[o + 1], this.px[o + 2]),
        blob: this._blobOf(cx, cy, Math.max(4, Math.round(8 * this.gs)))
      });
    }
    return chosen;
  };

  // The lit pixels that make up a cell body, so it can flash in its own shape.
  SynapseField.prototype._blobOf = function (cx, cy, r) {
    var W = this.W, H = this.H, lit = this.lit, out = [];
    for (var y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++)
      for (var x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) {
        var dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > r * r) continue;
        var i = y * W + x;
        if (lit[i]) out.push(i);
      }
    return new Int32Array(out);
  };

  SynapseField.prototype._bindSomas = async function () {
    var W = this.W, nodes = this.nodes;
    var pool = [];
    for (var i = 0; i < nodes.length; i++) if (nodes[i].segs.length) pool.push(i);
    var keep = [];
    for (var s = 0; s < this.somas.length; s++) {
      if ((s & 31) === 0) { var b0 = this._slice(); if (b0) await b0; }
      var so = this.somas[s], best = -1, bestD = 1e9;
      for (var p = 0; p < pool.length; p++) {
        var ni = nodes[pool[p]].i;
        var dx = (ni % W) - so.x, dy = ((ni / W) | 0) - so.y;
        var d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = pool[p]; }
      }
      var bindR = 90 * this.gs;
      if (best < 0 || bestD >= bindR * bindR) continue;
      var wired = 0;
      for (var w = 0; w < nodes[best].segs.length; w++) wired += this.segs[nodes[best].segs[w].s].len;
      if (wired < 14 * this.gs) continue;            // a stub, nothing can propagate from it
      so.node = best; keep.push(so);
    }
    this.somas = keep;
  };

  // ======================================================================
  // navigation — wheel/pinch zoom about the pointer, drag to pan,
  // shift-drag or a two-finger twist to spin the field through 360 degrees
  // ======================================================================
  SynapseField.prototype._controls = function () {
    var self = this, host = this.host;
    this.view = { x: 0, y: 0, s: 1, r: 0 };
    this._apply();
    host.classList.add('sf-interactive');

    var pointers = new Map(), last = null, gesture = null;

    function localFromEvent(ev) {
      var b = host.getBoundingClientRect();
      return { x: ev.clientX - (b.left + b.width / 2), y: ev.clientY - (b.top + b.height / 2) };
    }

    // keep the point under the cursor pinned while scale/rotation change
    function anchor(v, ds, dr) {
      var c = Math.cos(self.view.r), sn = Math.sin(self.view.r);
      var wx = ((v.x - self.view.x) * c + (v.y - self.view.y) * sn) / self.view.s;
      var wy = (-(v.x - self.view.x) * sn + (v.y - self.view.y) * c) / self.view.s;
      self.view.s = Math.max(0.35, Math.min(14, self.view.s * ds));
      self.view.r += dr;
      var c2 = Math.cos(self.view.r), s2 = Math.sin(self.view.r);
      self.view.x = v.x - self.view.s * (wx * c2 - wy * s2);
      self.view.y = v.y - self.view.s * (wx * s2 + wy * c2);
      self._apply();
    }
    this._anchor = anchor;

    host.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var f = Math.exp(-ev.deltaY * 0.0016);
      anchor(localFromEvent(ev), f, 0);
    }, { passive: false });

    host.addEventListener('pointerdown', function (ev) {
      host.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, localFromEvent(ev));
      if (pointers.size === 2) {
        var pts = [...pointers.values()];
        gesture = {
          d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
          a: Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x),
          m: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
        };
      }
      last = localFromEvent(ev);
      host.classList.add('sf-dragging');
    });

    host.addEventListener('pointermove', function (ev) {
      if (!pointers.has(ev.pointerId)) return;
      var cur = localFromEvent(ev);
      pointers.set(ev.pointerId, cur);

      if (pointers.size >= 2 && gesture) {
        var pts = [...pointers.values()];
        var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        var a = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
        var m = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        self.view.x += m.x - gesture.m.x;
        self.view.y += m.y - gesture.m.y;
        anchor(m, gesture.d > 4 ? d / gesture.d : 1, a - gesture.a);
        gesture = { d: d, a: a, m: m };
        return;
      }

      var dx = cur.x - last.x, dy = cur.y - last.y;
      if (ev.shiftKey || ev.buttons === 2) {
        // rotate about the centre of the view
        var a0 = Math.atan2(last.y - self.view.y, last.x - self.view.x);
        var a1 = Math.atan2(cur.y - self.view.y, cur.x - self.view.x);
        anchor({ x: self.view.x, y: self.view.y }, 1, a1 - a0);
      } else {
        self.view.x += dx; self.view.y += dy;
        self._apply();
      }
      last = cur;
    });

    function release(ev) {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) gesture = null;
      if (!pointers.size) host.classList.remove('sf-dragging');
    }
    host.addEventListener('pointerup', release);
    host.addEventListener('pointercancel', release);
    host.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    host.addEventListener('dblclick', function () { self.resetView(); });
  };

  SynapseField.prototype._apply = function () {
    var v = this.view;
    this.stage.style.transform = 'translate(' + v.x.toFixed(2) + 'px,' + v.y.toFixed(2) + 'px) ' +
      'rotate(' + (v.r * 180 / Math.PI).toFixed(3) + 'deg) scale(' + v.s.toFixed(4) + ')';
    if (this.onview) this.onview(v);
  };

  SynapseField.prototype.resetView = function () {
    this.view = { x: 0, y: 0, s: 1, r: 0 };
    this._apply();
  };

  SynapseField.prototype.zoomBy = function (f) {
    if (!this._anchor) return;
    this._anchor({ x: this.view.x, y: this.view.y }, f, 0);
  };

  SynapseField.prototype.rotateBy = function (deg) {
    if (!this._anchor) return;
    this._anchor({ x: this.view.x, y: this.view.y }, 1, deg * Math.PI / 180);
  };

  // ======================================================================
  // spiking
  // ======================================================================
  // Assemble a route: walk the graph from `node`, at every junction taking the
  // continuation that best preserves heading (optionally biased toward a far
  // target), until `maxLen` pixels of fibre have been strung together. The
  // result is ONE continuous path an impulse can run down.
  SynapseField.prototype._route = function (node, maxLen, inDir, banSeg, target) {
    var nodes = this.nodes, segs = this.segs, W = this.W;
    var cells = [], splits = [], prevSeg = banSeg == null ? -1 : banSeg;
    var cur = node, guard = 0;

    var tx = 0, ty = 0;
    while (cells.length < maxLen && guard++ < 400) {
      var nd = nodes[cur];
      if (!nd || !nd.segs.length) break;
      var np = nd.i, nx = np % W, ny = (np / W) | 0;
      if (target) { var d = norm(target.x - nx, target.y - ny); tx = d[0]; ty = d[1]; }

      var best = null, bestScore = -1e9, alts = [];
      var pc = prevSeg >= 0 ? segs[prevSeg].col : null;
      var lock = this.opt.colourLock;
      // In a dense reconstruction the fibres are short, so a strict refractory
      // rule strands the signal after a few hops. Prefer rested fibres; fall
      // back to partly-recovered ones before giving up on the route.
      var gate = SEG_REFRACTORY;
      for (var attempt = 0; attempt < 2 && !best; attempt++, gate *= 0.35) {
      for (var q = 0; q < nd.segs.length; q++) {
        var ref = nd.segs[q];
        if (ref.s === prevSeg) continue;
        if (this.time - this.segT[ref.s] < gate) continue;
        var sg = segs[ref.s];
        // direction we would set off in: the reverse of that end's exit vector
        var od = ref.from === 'a' ? [-sg.eA[0], -sg.eA[1]] : [-sg.eB[0], -sg.eB[1]];
        var score = Math.random() * 0.25;
        if (inDir) score += (inDir[0] * od[0] + inDir[1] * od[1]) * 1.0;
        if (target) score += (tx * od[0] + ty * od[1]) * 0.9;
        score += Math.min(sg.len, 80) / 400;            // prefer real fibres over stubs
        if (pc && lock > 0) {
          // stay on the same cell: its colour is its identity in these maps
          var dr = (sg.col[0] - pc[0]) / 255, dg = (sg.col[1] - pc[1]) / 255, db = (sg.col[2] - pc[2]) / 255;
          score += lock * (1 - Math.sqrt(dr * dr + dg * dg + db * db) / 1.732) - lock * 0.5;
        }
        alts.push(ref);
        if (score > bestScore) { bestScore = score; best = ref; }
      }
      }
      if (!best) break;

      var seg = segs[best.s];
      this.segT[best.s] = this.time;
      if (alts.length > 1) splits.push({ at: cells.length, node: cur, ban: best.s });

      if (best.from === 'a') {
        for (var c1 = 0; c1 < seg.len; c1++) cells.push(seg.cells[c1]);
        inDir = seg.eB;
        cur = seg.b;
      } else {
        for (var c2 = seg.len - 1; c2 >= 0; c2--) cells.push(seg.cells[c2]);
        inDir = seg.eA;
        cur = seg.a;
      }
      prevSeg = best.s;
      if (cur < 0) break;
    }
    if (cells.length < 8) return null;
    return { cells: new Int32Array(cells), splits: splits, col: this._colourAt(cells[0]) || [200, 220, 255], endDir: inDir, endNode: cur };
  };

  SynapseField.prototype._spawn = function (node, amp, reach, inDir, banSeg, target, gen) {
    if (this.impulses.length >= this.opt.impulseCap) return false;
    var r = this._route(node, reach, inDir, banSeg, target);
    if (!r) return false;
    var p = this.p;
    this.impulses.push({
      cells: r.cells, len: r.cells.length, splits: r.splits, si: 0,
      col: r.col, endNode: r.endNode, endDir: r.endDir,
      pos: 0, amp: amp, gen: gen || 0, target: target,
      speed: p.speed * (0.85 + Math.random() * 0.3),
      delay: 0
    });
    return true;
  };

  SynapseField.prototype._fire = function (soma, amp) {
    if (!soma || soma.cool > 0.85) return false;
    // every so often the cell drives a long projection at a distant partner,
    // so traffic keeps crossing to the outlying neurons
    var target = null;
    if (Math.random() < 0.6 && this.somas.length > 4) {
      for (var t = 0; t < 8; t++) {
        var c = this.somas[(Math.random() * this.somas.length) | 0];
        var dx = c.x - soma.x, dy = c.y - soma.y;
        var far = 420 * this.gs;
        if (dx * dx + dy * dy > far * far) { target = c; break; }
      }
    }
    var reach = this.p.reach * this.gs * this.opt.reachScale * (target ? 1.6 : 1) * (0.7 + Math.random() * 0.6);
    // a soma only enters its refractory period if the spike actually left it
    if (!this._spawn(soma.node, amp == null ? 1 : amp, reach, null, -1, target, 0)) return false;
    soma.cool = 1;
    this.heat[this._heatIndex(soma.x, soma.y)] += 1;
    this.somaFlashes.push({ soma: soma, t: 0 });
    this.stats.spikes++;
    return true;
  };

  SynapseField.prototype._heatIndex = function (x, y) {
    var hx = Math.min(this.heatW - 1, (x / this.W * this.heatW) | 0);
    var hy = Math.min(this.heatH - 1, (y / this.H * this.heatH) | 0);
    return hy * this.heatW + hx;
  };

  // Prefer a rested cell in a quiet part of the field, so activity spreads out
  // to the isolated neurons instead of pooling in the dense core.
  SynapseField.prototype._pickSoma = function () {
    var s = this.somas;
    if (!s.length) return null;
    var best = null, bestScore = -1e9;
    for (var t = 0; t < 9; t++) {
      var c = s[(Math.random() * s.length) | 0];
      var score = c.w * 0.35 - c.cool * 1.8 - this.heat[this._heatIndex(c.x, c.y)] * 0.5 + Math.random() * 0.4;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  };

  SynapseField.prototype.burst = function (count) {
    for (var i = 0; i < (count || 6); i++) this._fire(this._pickSoma(), 1.15);
  };

  SynapseField.prototype.setState = function (name) {
    if (!STATES[name] || this.state === name) return;
    this.state = name;
    this.target = STATES[name];
    if (name === 'acting') this.burst(7);
  };

  SynapseField.prototype.setLevel = function (v) {
    this.level = Math.max(0, Math.min(1, v || 0));
  };

  // ======================================================================
  // frame
  // ======================================================================
  SynapseField.prototype._frame = function (dt) {
    var p = this.p, t = this.target, W = this.W, H = this.H;
    var k = 1 - Math.exp(-dt * 3.2);
    for (var key in t) p[key] = lerp(p[key], t[key], k);
    this.time += dt;

    for (var hi2 = 0; hi2 < this.heat.length; hi2++) {
      this.heat[hi2] = Math.max(0, this.heat[hi2] - dt * 0.8);
    }
    for (var ri = 0; ri < this.somas.length; ri++) {
      var rs = this.somas[ri];
      if (rs.cool > 0) rs.cool = Math.max(0, rs.cool - dt / 1.3);
    }

    var drive = 1;
    if (this.state === 'speaking') {
      var rhythm = 0.4 + 0.8 * Math.abs(Math.sin(this.time * Math.PI * 3.0));
      drive = this.level > 0.01 ? 0.35 + this.level * 1.9 : rhythm;
    } else if (this.state === 'listening') {
      drive = 0.85 + this.level * 1.3;
    }

    this.spikeAcc += dt * p.rate * drive;
    while (this.spikeAcc >= 1) {
      this.spikeAcc -= 1;
      for (var tr = 0; tr < 5; tr++) {
        if (this._fire(this._pickSoma(), 0.85 + Math.random() * 0.3)) break;
      }
    }

    // ---- advance impulses ------------------------------------------------
    var alive = [];
    for (var ii = 0; ii < this.impulses.length; ii++) {
      var im = this.impulses[ii];
      if (im.delay > 0) { im.delay -= dt; alive.push(im); continue; }
      im.pos += im.speed * dt;

      // branch off where the route passed a junction
      while (im.si < im.splits.length && im.splits[im.si].at < im.pos) {
        var sp = im.splits[im.si++];
        if (Math.random() < p.branch * this.opt.branchScale && im.gen < 5 && alive.length < this.opt.impulseCap) {
          this._spawn(sp.node, im.amp * p.atten * 0.78,
            (p.reach * this.gs - sp.at) * 0.7, null, sp.ban, im.target, im.gen + 1);
        }
      }

      if (im.pos < im.len - 1) { alive.push(im); continue; }

      var endCell = im.cells[im.len - 1];
      // a free ending discharges; otherwise the signal is simply spent
      this.flashes.push({ i: endCell, t: 0, amp: im.amp, col: im.col });
    }
    this.impulses = alive;
    this.stats.active = alive.length;

    // ---- draw ------------------------------------------------------------
    var fx = this.fx;
    fx.globalCompositeOperation = 'destination-out';
    fx.fillStyle = 'rgba(0,0,0,' + Math.min(0.9, p.fade * dt * 60).toFixed(4) + ')';
    fx.fillRect(0, 0, W, H);
    fx.globalCompositeOperation = 'lighter';

    var boost = p.amp;
    for (var di = 0; di < this.impulses.length; di++) {
      var d = this.impulses[di];
      if (d.delay <= 0) this._drawImpulse(d, boost, p, dt);
    }

    // cell bodies
    var keptSoma = [];
    for (var fi = 0; fi < this.somaFlashes.length; fi++) {
      var f = this.somaFlashes[fi];
      f.t += dt;
      if (f.t > 0.34) continue;
      keptSoma.push(f);
      var e = 1 - f.t / 0.34, a = e * e * p.soma;
      var so = f.soma, col = so.col;
      fx.fillStyle = 'rgba(' + Math.min(255, col[0] + 70) + ',' + Math.min(255, col[1] + 70) + ',' +
        Math.min(255, col[2] + 70) + ',' + (a * 0.9).toFixed(3) + ')';
      var blob = so.blob;
      fx.beginPath();
      for (var bi = 0; bi < blob.length; bi++) fx.rect(blob[bi] % W, (blob[bi] / W) | 0, 1, 1);
      fx.fill();
      var rad = (7 + 9 * e) * Math.max(0.55, this.gs);
      var g = fx.createRadialGradient(so.x, so.y, 0, so.x, so.y, rad);
      g.addColorStop(0, 'rgba(' + col.join(',') + ',' + (a * 0.5).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      fx.fillStyle = g;
      fx.beginPath(); fx.arc(so.x, so.y, rad, 0, 6.2832); fx.fill();
    }
    this.somaFlashes = keptSoma;

    // terminal boutons
    var keptFlash = [];
    for (var xi = 0; xi < this.flashes.length; xi++) {
      var fl = this.flashes[xi];
      fl.t += dt;
      if (fl.t > 0.22) continue;
      keptFlash.push(fl);
      var ee = 1 - fl.t / 0.22;
      var bx = fl.i % W, by = (fl.i / W) | 0;
      var rr = (1.5 + 3.5 * (1 - ee)) * Math.max(0.6, this.gs);
      var aa = ee * ee * fl.amp * boost;
      var gg = fx.createRadialGradient(bx, by, 0, bx, by, rr);
      gg.addColorStop(0, 'rgba(255,255,255,' + (aa * 0.5).toFixed(3) + ')');
      gg.addColorStop(0.4, 'rgba(' + fl.col.join(',') + ',' + (aa * 0.65).toFixed(3) + ')');
      gg.addColorStop(1, 'rgba(0,0,0,0)');
      fx.fillStyle = gg;
      fx.beginPath(); fx.arc(bx, by, rr, 0, 6.2832); fx.fill();
    }
    this.flashes = keptFlash;

    // resting shimmer along the fibres
    this.twinkleAcc += dt * p.twinkle * drive;
    var sc = this.skelCells;
    while (this.twinkleAcc >= 1 && sc.length) {
      this.twinkleAcc -= 1;
      var ci = sc[(Math.random() * sc.length) | 0];
      var o2 = ci * 4, a2 = (0.1 + Math.random() * 0.3) * boost;
      fx.fillStyle = 'rgba(' + this.px[o2] + ',' + this.px[o2 + 1] + ',' + this.px[o2 + 2] + ',' + a2.toFixed(3) + ')';
      fx.fillRect(ci % W, (ci / W) | 0, 1.6 * Math.max(0.6, this.gs), 1.6 * Math.max(0.6, this.gs));
    }

    fx.globalCompositeOperation = 'source-over';

    var gc = this.glow;
    gc.globalCompositeOperation = 'copy';
    gc.drawImage(this.fxCanvas, 0, 0, this.glowCanvas.width, this.glowCanvas.height);

    this.base.style.filter = 'brightness(' + p.base.toFixed(3) + ')';
  };

  // One impulse: a bright head with a decaying depolarised tail behind it,
  // stroked along the fibre's actual path.
  // Full-chroma version of a pixel: stretched between its min and max channel,
  // so a pale fibre fires in its own hue instead of washing out to white.
  function saturate(r, g, b) {
    var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    var d = mx - mn;
    if (d < 10) return [(r / (mx || 1) * 255) | 0, (g / (mx || 1) * 255) | 0, (b / (mx || 1) * 255) | 0];
    var k = 255 / d;
    return [((r - mn) * k) | 0, ((g - mn) * k) | 0, ((b - mn) * k) | 0];
  }

  SynapseField.prototype._colourAt = function (cell) {
    var o = cell * 4, px = this.px;
    var r = px[o], g = px[o + 1], b = px[o + 2];
    if (r < 40 && g < 40 && b < 40) return null;   // off the tissue
    return saturate(r, g, b);
  };

  SynapseField.prototype._drawImpulse = function (im, boost, p, dt) {
    var cells = im.cells, W = this.W, fx = this.fx;
    var seg = { len: im.len };
    var bead = Math.max(6, p.bead * this.gs);
    var head = im.pos;
    var tail = head - bead;
    // The bead is redrawn every frame while it slides over the same pixels, so
    // each frame may only deposit its share of the energy — otherwise additive
    // blending clips to white and the tissue colour is lost.
    var deposit = Math.min(1, (im.speed * (dt || 0.016)) / bead) * 1.9;
    var amp = im.amp * boost * deposit;

    var gsw = Math.max(0.55, this.gs);
    var bands = [[0.00, 0.40, 0.16, 1.4 * gsw], [0.40, 0.72, 0.45, 1.9 * gsw], [0.72, 0.92, 0.85, 2.4 * gsw], [0.92, 1.00, 1.0, 2.9 * gsw]];
    for (var b = 0; b < bands.length; b++) {
      var band = bands[b];
      var s0 = tail + (head - tail) * band[0];
      var s1 = tail + (head - tail) * band[1];
      var i0 = Math.max(0, Math.min(seg.len - 1, Math.round(Math.min(s0, s1))));
      var i1 = Math.max(0, Math.min(seg.len - 1, Math.round(Math.max(s0, s1))));
      if (i1 - i0 < 1) continue;
      var alpha = band[2] * amp;
      if (alpha < 0.012) continue;
      var col = this._colourAt(cells[(i0 + i1) >> 1]) || im.col;
      var white = b === 3 ? (p.core * 120) | 0 : (b === 2 ? (p.core * 45) | 0 : 0);
      fx.strokeStyle = 'rgba(' + Math.min(255, col[0] + white) + ',' + Math.min(255, col[1] + white) + ',' +
        Math.min(255, col[2] + white) + ',' + alpha.toFixed(3) + ')';
      fx.lineWidth = band[3];
      fx.beginPath();
      var stepN = Math.max(1, ((i1 - i0) / 10) | 0);
      fx.moveTo(cells[i0] % W, (cells[i0] / W) | 0);
      for (var q = i0 + stepN; q < i1; q += stepN) fx.lineTo(cells[q] % W, (cells[q] / W) | 0);
      fx.lineTo(cells[i1] % W, (cells[i1] / W) | 0);
      fx.stroke();
    }

    // the hot head
    var hi = Math.max(0, Math.min(seg.len - 1, Math.round(head)));
    var col = this._colourAt(cells[hi]) || im.col;
    var hx = cells[hi] % W, hy = (cells[hi] / W) | 0;
    var headAmp = im.amp * boost * Math.min(1, deposit * 2.2);
    var hr = (4.5 + 4 * p.core) * gsw;
    var g = fx.createRadialGradient(hx, hy, 0, hx, hy, hr);
    g.addColorStop(0, 'rgba(' + Math.min(255, col[0] + 55) + ',' + Math.min(255, col[1] + 55) + ',' + Math.min(255, col[2] + 55) + ',' + (0.55 * headAmp).toFixed(3) + ')');
    g.addColorStop(0.4, 'rgba(' + col.join(',') + ',' + (0.42 * headAmp).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    fx.fillStyle = g;
    fx.beginPath(); fx.arc(hx, hy, hr, 0, 6.2832); fx.fill();
  };

  SynapseField.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    var generation = this.frameGeneration = (this.frameGeneration || 0) + 1;
    var self = this, last = performance.now(), acc = 0, frames = 0;
    var minStep = this.opt.fps > 0 ? 1 / this.opt.fps - 0.002 : 0;
    function loop(now) {
      if (!self.running || self.frameGeneration !== generation) return;
      var dt = (now - last) / 1000;
      if (minStep && dt < minStep) { self.frameRequest = requestAnimationFrame(loop); return; }
      dt = Math.min(0.05, dt);
      last = now;
      acc += dt; frames++;
      if (acc > 0.5) { self.stats.fps = Math.round(frames / acc); acc = 0; frames = 0; }
      self._frame(dt);
      if (self.onframe) self.onframe(self.stats);
      if (self.running && self.frameGeneration === generation) self.frameRequest = requestAnimationFrame(loop);
    }
    this.frameRequest = requestAnimationFrame(loop);
  };

  SynapseField.prototype.stop = function () {
    this.running = false;
    this.frameGeneration = (this.frameGeneration || 0) + 1;
    if (this.frameRequest != null) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = null;
  };

  SynapseField.prototype.destroy = function () {
    this.stop();
    if (this.stage && this.stage.parentNode) this.stage.parentNode.removeChild(this.stage);
    this.host.classList.remove('sf-host', 'sf-interactive', 'sf-dragging');
    this.impulses = []; this.px = null; this.lit = null; this.bright = null; this.skel = null;
  };

  SynapseField.STATES = STATES;
  global.SynapseField = SynapseField;
})(window);
