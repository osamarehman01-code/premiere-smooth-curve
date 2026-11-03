/* Premiere Smooth Curve - easing math. Works in the CEP panel (window.PSEase) and in Node (module.exports) for tests. */
(function (root) {
  'use strict';

  // ---- cubic bezier (CSS-style: P0=(0,0), P3=(1,1), y of handles may overshoot) ----
  function bezierAxis(t, p1, p2) {
    var u = 1 - t;
    return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
  }
  function bezierAxisDeriv(t, p1, p2) {
    var u = 1 - t;
    return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
  }
  function solveT(x, x1, x2) {
    // Newton then bisection fallback; x handles are clamped to [0,1] so x(t) is monotonic
    var t = x, i;
    for (i = 0; i < 8; i++) {
      var err = bezierAxis(t, x1, x2) - x;
      if (Math.abs(err) < 1e-7) return t;
      var d = bezierAxisDeriv(t, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    var lo = 0, hi = 1;
    t = x;
    for (i = 0; i < 60; i++) {
      var xv = bezierAxis(t, x1, x2);
      if (Math.abs(xv - x) < 1e-7) return t;
      if (xv < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  }
  function bezier(p) {
    var x1 = clamp(p.x1, 0, 1), x2 = clamp(p.x2, 0, 1), y1 = p.y1, y2 = p.y2;
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      return bezierAxis(solveT(x, x1, x2), y1, y2);
    };
  }

  // ---- physics-style curves ----
  function elastic(p) { // ease-out elastic: overshoots and settles at 1
    var amp = Math.max(1, p.amplitude || 1), period = Math.max(0.05, p.period || 0.3);
    var s = period / (2 * Math.PI) * Math.asin(1 / amp);
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      return amp * Math.pow(2, -10 * x) * Math.sin((x - s) * (2 * Math.PI) / period) + 1;
    };
  }
  function bounce(p) { // n bounces with energy loss, lands exactly at 1
    var n = Math.max(1, Math.round(p.bounces || 3)), k = clamp(p.bounciness || 0.5, 0.1, 0.9);
    // segment durations: first fall = 1 unit, each bounce lasts sqrt(k)^i * 2 units
    var r = Math.sqrt(k), durs = [1], total = 1, i;
    for (i = 1; i <= n; i++) { durs.push(2 * Math.pow(r, i)); total += durs[i]; }
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var tt = x * total;
      if (tt < durs[0]) { var a = tt / durs[0]; return a * a; }
      tt -= durs[0];
      for (var j = 1; j <= n; j++) {
        if (tt < durs[j]) {
          var h = Math.pow(k, j), c = tt / durs[j]; // parabola 0..1..0 over the bounce
          return 1 - h * (1 - Math.pow(2 * c - 1, 2));
        }
        tt -= durs[j];
      }
      return 1;
    };
  }
  function spring(p) { // damped harmonic oscillator, normalised so f(1) = 1
    var stiff = clamp(p.stiffness || 180, 10, 1000), damp = clamp(p.damping || 12, 1, 100), mass = 1;
    var w0 = Math.sqrt(stiff / mass), zeta = damp / (2 * Math.sqrt(stiff * mass)), dur = clamp(p.duration || 1, 0.2, 5);
    function raw(t) {
      var T = t * dur;
      if (zeta < 1) {
        var wd = w0 * Math.sqrt(1 - zeta * zeta);
        return 1 - Math.exp(-zeta * w0 * T) * (Math.cos(wd * T) + (zeta * w0 / wd) * Math.sin(wd * T));
      }
      return 1 - Math.exp(-w0 * T) * (1 + w0 * T);
    }
    var end = raw(1);
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var v = raw(x);
      // blend residual so the curve lands exactly on the target keyframe
      return v + (1 - end) * x * x * x;
    };
  }

  var TYPES = ['bezier', 'elastic', 'bounce', 'spring'];
  var DEFAULTS = {
    bezier: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
    elastic: { amplitude: 1, period: 0.3 },
    bounce: { bounces: 3, bounciness: 0.5 },
    spring: { stiffness: 180, damping: 12, duration: 1 }
  };
  function make(curve) {
    var p = curve.params || {};
    switch (curve.type) {
      case 'elastic': return elastic(p);
      case 'bounce': return bounce(p);
      case 'spring': return spring(p);
      default: return bezier(p);
    }
  }
  // Lookup table sent to the ExtendScript host (it only interpolates, never re-implements the math)
  function lut(curve, n) {
    n = n || 1000;
    var f = make(curve), out = [], i;
    for (i = 0; i <= n; i++) out.push(Math.round(f(i / n) * 1e6) / 1e6);
    out[0] = 0; out[n] = 1;
    return out;
  }
  function speedSamples(curve, n) {
    n = n || 200;
    var f = make(curve), out = [], h = 1 / n, i, max = 0;
    for (i = 0; i <= n; i++) {
      var a = Math.max(0, i * h - h / 2), b = Math.min(1, i * h + h / 2);
      var v = (f(b) - f(a)) / (b - a);
      out.push(v);
      if (Math.abs(v) > max) max = Math.abs(v);
    }
    return { values: out, max: max || 1 };
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  var BUILTIN = [
    { name: 'Ease In Out (default)', type: 'bezier', params: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } },
    { name: 'Ease In Out Sine', type: 'bezier', params: { x1: 0.37, y1: 0, x2: 0.63, y2: 1 } },
    { name: 'Ease In Out Cubic', type: 'bezier', params: { x1: 0.65, y1: 0, x2: 0.35, y2: 1 } },
    { name: 'Ease In Out Quint', type: 'bezier', params: { x1: 0.83, y1: 0, x2: 0.17, y2: 1 } },
    { name: 'Ease In Out Expo', type: 'bezier', params: { x1: 0.87, y1: 0, x2: 0.13, y2: 1 } },
    { name: 'Ease Out Cubic', type: 'bezier', params: { x1: 0.33, y1: 1, x2: 0.68, y2: 1 } },
    { name: 'Ease Out Quint', type: 'bezier', params: { x1: 0.22, y1: 1, x2: 0.36, y2: 1 } },
    { name: 'Ease Out Expo', type: 'bezier', params: { x1: 0.16, y1: 1, x2: 0.3, y2: 1 } },
    { name: 'Ease In Cubic', type: 'bezier', params: { x1: 0.32, y1: 0, x2: 0.67, y2: 0 } },
    { name: 'Ease In Expo', type: 'bezier', params: { x1: 0.7, y1: 0, x2: 0.84, y2: 0 } },
    { name: 'Back Out (overshoot)', type: 'bezier', params: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 } },
    { name: 'Back In Out', type: 'bezier', params: { x1: 0.68, y1: -0.6, x2: 0.32, y2: 1.6 } },
    { name: 'Whip (fast start)', type: 'bezier', params: { x1: 0.05, y1: 0.9, x2: 0.1, y2: 1 } },
    { name: 'Slow-mo middle', type: 'bezier', params: { x1: 0.1, y1: 0.75, x2: 0.9, y2: 0.25 } },
    { name: 'Elastic Out', type: 'elastic', params: { amplitude: 1, period: 0.3 } },
    { name: 'Elastic Soft', type: 'elastic', params: { amplitude: 1, period: 0.5 } },
    { name: 'Bounce 3', type: 'bounce', params: { bounces: 3, bounciness: 0.5 } },
    { name: 'Bounce Light', type: 'bounce', params: { bounces: 2, bounciness: 0.3 } },
    { name: 'Spring Snappy', type: 'spring', params: { stiffness: 300, damping: 14, duration: 1 } },
    { name: 'Spring Wobbly', type: 'spring', params: { stiffness: 180, damping: 6, duration: 1.4 } }
  ];

  var api = { make: make, lut: lut, speedSamples: speedSamples, TYPES: TYPES, DEFAULTS: DEFAULTS, BUILTIN: BUILTIN, clamp: clamp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PSEase = api;
})(typeof window !== 'undefined' ? window : this);
