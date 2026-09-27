/*
 * Echo's neural core — action potentials running on a real neuron micrograph.
 *
 * The visual is not a schematic: `SynapseField` reads the micrograph back pixel
 * by pixel, skeletonises every neurite, traces the centrelines into fibres, and
 * conducts impulses down the actual dendrites in their own colour (see
 * renderer/synapse/README.md). Canvas 2D only, so it stays off the GPU
 * compositor path that made transparent animated windows pin this machine.
 *
 * Firing rate tracks Echo's own status: idle barely ticks over, listening picks
 * up, thinking/speaking runs hot, acting is a storm.
 */
(() => {
  const host = document.getElementById("field");
  const $ = (id) => document.getElementById(id);
  const MAPS = window.ECHO_SYNAPSE_MAPS;
  const order = ["dense", "cluster"];

  let field = null;
  let mapIndex = 0;
  let status = "idle";

  function load(name) {
    const map = MAPS[name];
    if (!map) return;
    if (field) field.destroy();
    host.innerHTML = "";
    // chunked: the geometry pass yields between slices, so the window paints
    // and stays responsive while it builds instead of freezing for ~400ms
    field = window.field = new SynapseField(Object.assign({ host, imageSrc: map.src, chunked: true }, map));
    field.ready.then(() => {
      $("nodes").textContent = field.stats.somas;
      $("syn").textContent = field.stats.fibres.toLocaleString();
      field.setState(window.ECHO_SYNAPSE_STATE(status));
      field.onframe = (s) => { $("temp").textContent = s.active + " live"; };
      field.onview = (v) => {
        $("viewinfo").textContent =
          "zoom " + v.s.toFixed(2) + "× · " +
          Math.round(((v.r * 180 / Math.PI) % 360 + 360) % 360) + "°";
      };
    }).catch((err) => {
      $("corestate").textContent = "OFFLINE";
      if (window.jarvis && window.jarvis.reportError) {
        window.jarvis.reportError({ kind: "neural", message: String(err && err.message || err), source: "neural.js" });
      }
    });
  }

  load(order[mapIndex]);

  // ---- Echo's state drives the firing rate ----
  function apply(next) {
    status = next || "idle";
    $("corestate").textContent = String(status).toUpperCase();
    if (field) field.setState(window.ECHO_SYNAPSE_STATE(status));
  }

  if (window.echoNeural && window.echoNeural.onState) {
    window.echoNeural.onState((s) => {
      if (s && s.status) apply(s.status);
    });
  }
  if (window.echoNeural && window.echoNeural.onLevel) {
    // voice amplitude: listening leans in with your voice, speaking pulses with Echo's
    window.echoNeural.onLevel((n) => { if (field) field.setLevel(n); });
  }

  // ---- chrome ----
  $("map").onclick = () => { mapIndex = (mapIndex + 1) % order.length; load(order[mapIndex]); };
  $("reset").onclick = () => field && field.resetView();
  $("close").onclick = () => window.echoNeural && window.echoNeural.close();
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.echoNeural && window.echoNeural.close();
    if (e.key.toLowerCase() === "r") field && field.resetView();
    if (e.key === "+" || e.key === "=") field && field.zoomBy(1.25);
    if (e.key === "-") field && field.zoomBy(1 / 1.25);
    if (e.key === "[") field && field.rotateBy(-15);
    if (e.key === "]") field && field.rotateBy(15);
  });
})();
