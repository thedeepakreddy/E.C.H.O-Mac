/*
 * Build settings per micrograph, shared by the neural window, the control
 * panel card and the demo — see README for why the two maps need different
 * masks (the dense reconstruction is a solid slab at a plain luminance cut).
 */
window.ECHO_SYNAPSE_MAPS = {
  dense: {
    src: window.ECHO_NEURON_IMAGES.dense, aspect: '1500 / 1000',
    threshold: 60, minSat: 40, closeR: 2, bridgeR: 8,
    somaCut: 0.07, somaR: 10, somaNMS: 28,
    colourLock: 1.5, branchScale: 0.45, reachScale: 1.8
  },
  cluster: {
    src: window.ECHO_NEURON_IMAGES.cluster, aspect: '1500 / 900',
    threshold: 26, minSat: 0, closeR: 2, bridgeR: 9,
    somaCut: 0.045, somaR: 9, somaNMS: 26,
    colourLock: 0.9
  }
};

/** Echo's HUD status -> a firing state. */
window.ECHO_SYNAPSE_STATE = function (status) {
  switch (status) {
    case 'listening': return 'listening';
    case 'thinking': case 'confirming': return 'thinking';
    case 'speaking': return 'speaking';
    case 'acting': return 'acting';
    default: return 'idle';        // idle, asleep, error
  }
};
