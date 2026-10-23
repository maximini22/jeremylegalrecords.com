/* Web Audio plucked-string synth (Karplus-Strong) and a lookahead step scheduler for layered tracks (per-note gain). Exposed as window.TabAudio. */
(function () {
  'use strict';
  var ctx = null, master = null, unlocked = false;
  var cache = {};

  function ensure() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    master = ctx.createGain(); master.gain.value = 0.55;
    master.connect(comp); comp.connect(ctx.destination);
    return ctx;
  }
  // Mobile browsers only start audio inside a user gesture: create/resume and play one silent sample.
  function unlock() {
    if (unlocked && ctx && ctx.state === 'running') return;
    var c = ensure(); if (!c) return;
    if (c.state === 'suspended') c.resume();
    var b = c.createBuffer(1, 1, c.sampleRate), s = c.createBufferSource();
    s.buffer = b; s.connect(c.destination); s.start(0);
    unlocked = true;
  }
  ['pointerdown', 'touchend', 'keydown', 'click'].forEach(function (ev) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  });

  function freq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  // Karplus-Strong: a noise burst through a damped delay line of one period.
  function pluckBuffer(midi, muted) {
    var key = midi + (muted ? 'm' : '');
    if (cache[key]) return cache[key];
    var sr = ctx.sampleRate, f = freq(midi);
    var len = Math.floor(sr * (muted ? 0.12 : 2.4));
    var buf = ctx.createBuffer(1, len, sr), out = buf.getChannelData(0);
    var N = Math.max(2, Math.round(sr / f)), line = new Float32Array(N);
    for (var i = 0; i < N; i++) line[i] = Math.random() * 2 - 1;
    var decay = muted ? 0.90 : 0.996 - Math.min(0.006, f / 200000), p = 0, prev = 0;
    for (var n = 0; n < len; n++) {
      var cur = line[p];
      var next = decay * 0.5 * (cur + prev);
      prev = cur; line[p] = next; out[n] = cur;
      p = (p + 1) % N;
    }
    // soften the attack click
    for (var a = 0; a < Math.min(64, len); a++) out[a] *= a / 64;
    cache[key] = buf;
    return buf;
  }

  // Play one note at time `when` for `dur` seconds (rings a little past, then fades).
  function note(midi, when, dur, opts) {
    var c = ensure(); if (!c) return;
    opts = opts || {};
    var muted = !!opts.muted;
    var src = c.createBufferSource(), g = c.createGain();
    src.buffer = pluckBuffer(midi, muted);
    var vol = (muted ? 0.35 : 0.5) * (opts.gain == null ? 1 : opts.gain);
    if (vol <= 0) return;
    var end = when + Math.max(0.08, dur) + (muted ? 0 : 0.04);
    g.gain.setValueAtTime(vol, when);
    g.gain.setTargetAtTime(0, end, 0.04);
    src.connect(g); g.connect(master);
    src.start(when);
    src.stop(Math.min(when + src.buffer.duration, end + 0.4));
  }
  var last = null;
  function preview(midi, muted) { last = { midi: midi, muted: !!muted }; unlock(); if (!ctx) return; note(midi, ctx.currentTime + 0.01, 0.9, { muted: muted }); }

  // Scheduler: getSteps() returns [{seconds-free step}] lazily so BPM/edits apply on the next step.
  var timer = null, playing = null;
  function play(opts) {
    stop();
    unlock(); var c = ensure(); if (!c) return false;
    // opts: { count, startAt, stepAt(i) -> {ticks, notes:[{midi, muted, offset (ticks into the step), ticks (length), gain (0-1), track}]}, bpm(), ppq, loop, onStep(i|null) }
    playing = { opts: opts, i: Math.max(0, Math.min((opts.count || 1) - 1, opts.startAt || 0)), next: c.currentTime + 0.08, queue: [], raf: 0 };
    log = []; t0 = playing.next;
    timer = setInterval(tick, 25);
    tick();
    var draw = function () {
      if (!playing) return;
      var now = c.currentTime;
      while (playing.queue.length && playing.queue[0].t <= now) {
        var q = playing.queue.shift();
        if (q.end) { var cb = playing.opts.onStep; stop(); if (cb) cb(null); return; }
        playing.opts.onStep(q.i);
      }
      playing.raf = requestAnimationFrame(draw);
    };
    playing.raf = requestAnimationFrame(draw);
    return true;
  }
  function tick() {
    if (!playing) return;
    var P = playing, o = P.opts;
    while (P.next < ctx.currentTime + 0.15) {
      if (P.i >= o.count) {
        if (o.loop && o.count > 0) P.i = 0;
        else { if (!P.ended) { P.ended = true; P.queue.push({ t: P.next, end: true }); } return; }
      }
      var st = o.stepAt(P.i);
      var secs = st.ticks / o.ppq * 60 / o.bpm();
      var spt = 60 / o.bpm() / o.ppq; // seconds per tick
      // Layered tracks: each note carries its track's volume; thin out big stacks so 3 tracks don't clip.
      var stack = st.notes.length > 6 ? 0.6 : st.notes.length > 2 ? 0.8 : 1;
      st.notes.forEach(function (n) {
        var gain = (n.gain == null ? 1 : n.gain) * stack;
        if (log.length < 2000) log.push({ midi: n.midi, muted: !!n.muted, at: +(P.next + (n.offset || 0) * spt - t0).toFixed(4), step: P.i, track: n.track == null ? null : n.track, gain: +gain.toFixed(3) });
        note(n.midi, P.next + (n.offset || 0) * spt, (n.ticks || st.ticks) * spt, { muted: n.muted, gain: gain });
      });
      P.queue.push({ t: P.next, i: P.i });
      P.next += secs; P.i++;
    }
  }
  var log = [], t0 = 0; // what was scheduled, in seconds from the start of playback (for tests)
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (playing) { cancelAnimationFrame(playing.raf); playing = null; }
  }
  window.TabAudio = { unlock: unlock, preview: preview, play: play, stop: stop, isPlaying: function () { return !!playing; },
    lastNote: function () { return last; }, scheduled: function () { return log.slice(); }, state: function () { return ctx ? ctx.state : 'none'; } };
})();
