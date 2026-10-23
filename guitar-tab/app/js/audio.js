/* Web Audio player for sampled guitar and bass Sounds (v9) and a lookahead step scheduler for layered tracks (per-note
 * gain). Exposed as window.TabAudio. There is no synthesised guitar: every note is a recorded sample, repitched.
 *
 * Sounds (tones): one mono 64 kbps MP3 sprite per Sound plus a small JSON manifest, in app/tones/<id>.{mp3,json}
 * (made by tools/tones/; licences in NOTICE). Guitar Sounds: 17 notes E2..E6 every 3 semitones, about 1.6 s each.
 * Bass Sounds: 10 notes E1..E3 every 3 semitones (Upright 2.0 s, Electric 1.6 s) and they sound an octave below the
 * tab. Each note plays from the nearest sample, repitched with playbackRate (at most 1.5 semitones, plus the measured
 * tuning correction in the manifest's 'cents').
 * Loading: lazy, one request pair per Sound, kept in its own Cache Storage cache (TONE_CACHE, separate from the app
 * shell cache, so app updates don't download samples again and samples work offline once used). The app asks for
 * Nylon right after first paint and for the other Sounds only when a track uses them. Playback waits for the Sounds
 * it needs (whenReady); a Sound that fails to load falls back to Nylon. */
(function () {
  'use strict';
  var ctx = null, master = null, unlocked = false;
  var TONE_CACHE = 'gt-tones-v1', TONE_DIR = 'tones/';

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

  // ---------- Sounds ----------
  function toneDefs() { var M = window.TabModel; return (M && M.TONE_BY_ID) || { nylon: { id: 'nylon', bass: false } }; }
  function def(id) { var d = toneDefs(); return d[id] || d.nylon; }
  var tones = {}, listeners = [], reqLog = [];
  function emit(id) { listeners.forEach(function (f) { try { f(id, tones[id] && tones[id].state); } catch (e) { /* ui */ } }); }
  // Cache-first through TONE_CACHE (works with or without the service worker, and offline once cached).
  function getFile(name) {
    var url = new URL(TONE_DIR + name, document.baseURI).href;
    var net = function () {
      reqLog.push({ url: url, t: +performance.now().toFixed(1) });
      return fetch(url, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r; });
    };
    if (!window.caches) return net();
    return caches.open(TONE_CACHE).then(function (c) {
      return c.match(url).then(function (hit) {
        if (hit) return hit;
        return net().then(function (r) { var keep = r.clone(); return c.put(url, keep).catch(function () { /* full */ }).then(function () { return r; }); });
      });
    }, net);
  }
  var dctx = null;
  function decoder() {
    if (ctx) return ctx;
    if (!dctx) { var O = window.OfflineAudioContext || window.webkitOfflineAudioContext; dctx = O ? new O(1, 1, 44100) : ensure(); }
    return dctx;
  }
  function decode(ab) {
    var c = decoder();
    return new Promise(function (res, rej) { var pr = c.decodeAudioData(ab, res, rej); if (pr && pr.then) pr.then(res, rej); });
  }
  // Cut the decoded sprite into one AudioBuffer per note. MP3 decoders differ in how much encoder delay they trim, so
  // the offset is re-measured: the median shift of each note's 20 %-of-peak crossing from where the manifest has it.
  function slice(buf, man) {
    var sr = buf.sampleRate, d = buf.getChannelData(0), shifts = [];
    man.notes.forEach(function (n) {
      var a = Math.max(0, Math.floor((n.at - 0.045) * sr)), b = Math.min(d.length, Math.floor((n.at + n.dur) * sr)), pk = 0, i;
      for (i = a; i < Math.min(b, a + Math.floor(0.6 * sr)); i++) if (Math.abs(d[i]) > pk) pk = Math.abs(d[i]);
      var lim = Math.min(b, Math.floor((n.at + n.x20 + 0.06) * sr));
      for (i = a; i < lim; i++) if (Math.abs(d[i]) >= 0.2 * pk) break;
      if (i < lim) shifts.push(i / sr - (n.at + n.x20));
    });
    shifts.sort(function (x, y) { return x - y; });
    var shift = shifts.length ? shifts[Math.floor(shifts.length / 2)] : 0;
    if (Math.abs(shift) > 0.04) shift = 0;
    var c = decoder();
    return { shift: shift, notes: man.notes.map(function (n) {
      var s0 = Math.max(0, Math.round((n.at + shift) * sr)), len = Math.max(1, Math.min(d.length - s0, Math.round(n.dur * sr)));
      var nb = c.createBuffer(1, len, sr);
      if (nb.copyToChannel) nb.copyToChannel(d.subarray(s0, s0 + len), 0); else nb.getChannelData(0).set(d.subarray(s0, s0 + len));
      return { root: n.root, cents: n.cents || 0, buf: nb };
    }) };
  }
  function load(id) {
    if (!toneDefs()[id]) id = 'nylon';
    var T = tones[id] || (tones[id] = { state: 'idle' });
    if (T.state === 'ready') return Promise.resolve(id);
    if (T.promise) return T.promise;
    T.state = 'loading'; emit(id);
    T.promise = getFile(id + '.json').then(function (r) { return r.json(); }).then(function (man) {
      return getFile(id + '.mp3').then(function (r) { return r.arrayBuffer(); }).then(decode).then(function (buf) {
        var s = slice(buf, man);
        T.notes = s.notes; T.shift = s.shift; T.gain = man.gain || 1; T.state = 'ready'; T.promise = null; emit(id);
        return id;
      });
    }).catch(function (e) {
      T.state = 'error'; T.error = String(e && e.message || e); T.promise = null; emit(id);
      throw e;
    });
    return T.promise;
  }
  function isReady(id) { return !!(tones[id] && tones[id].state === 'ready'); }
  // What a track's Sound plays as right now: itself when loaded, Nylon if it failed (and Nylon is loaded), else null.
  function effective(id) {
    if (!toneDefs()[id]) id = 'nylon';
    if (isReady(id)) return id;
    if (tones[id] && tones[id].state === 'error' && isReady('nylon')) return 'nylon';
    return null;
  }
  // Load every Sound in ids (retrying failed ones once); resolves { failed: [ids that fell back to Nylon] }.
  // Rejects only if Nylon itself can't be loaded (then nothing can play).
  function whenReady(ids) {
    var uniq = []; (ids || []).forEach(function (x) { x = toneDefs()[x] ? x : 'nylon'; if (uniq.indexOf(x) < 0) uniq.push(x); });
    return Promise.all(uniq.map(function (x) { return load(x).then(function () { return null; }, function () { return x; }); })).then(function (bad) {
      var failed = bad.filter(Boolean);
      if (!failed.length) return { failed: [] };
      return load('nylon').then(function () { return { failed: failed.filter(function (x) { return x !== 'nylon'; }) }; });
    });
  }
  function pick(T, m) {
    var best = T.notes[0];
    T.notes.forEach(function (n) { if (Math.abs(n.root - m) < Math.abs(best.root - m)) best = n; });
    return best;
  }

  // Play one note at time `when` for `dur` seconds (rings a little past, then fades). midi = the tab pitch; bass Sounds
  // play it an octave down. Muted (x) notes: the same sample, darker and choked after ~50 ms. Returns what sounded.
  var MUTED_PEAK = 0.35;
  function note(midi, when, dur, opts) {
    var c = ensure(); if (!c) return null;
    opts = opts || {};
    var tone = effective(opts.tone || 'nylon'); if (!tone) return null;
    var T = tones[tone], muted = !!opts.muted, sound = midi + (def(tone).bass ? -12 : 0);
    var vol = (muted ? MUTED_PEAK : NOTE_PEAK) * (opts.gain == null ? 1 : opts.gain) * T.gain;
    if (vol <= 0) return null;
    var smp = pick(T, sound), rate = Math.pow(2, (sound - smp.root) / 12 - smp.cents / 1200);
    var src = c.createBufferSource(), g = c.createGain(), last = src;
    src.buffer = smp.buf; src.playbackRate.value = rate;
    var end = when + Math.max(0.08, dur) + (muted ? 0 : 0.04), stopAt = Math.min(when + smp.buf.duration / rate, end + 0.4);
    g.gain.setValueAtTime(vol, when);
    if (muted) {
      var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400; lp.Q.value = 0.5;
      src.connect(lp); last = lp;
      g.gain.setTargetAtTime(0, when + 0.035, 0.015); stopAt = Math.min(stopAt, when + 0.2);
    } else g.gain.setTargetAtTime(0, end, 0.04);
    last.connect(g); g.connect(master);
    src.start(when);
    src.stop(stopAt);
    if (opts.sched) voices.push({ src: src, g: g, when: when, stopAt: stopAt });
    return { tone: tone, sound: sound };
  }
  // Metronome click (v8.2): an MPC-style soft woody tick, synthesised (no samples): a band-passed noise burst plus a
  // short sine blip, ~15 ms decay. Fixed level 0.2 = half the peak gain of a note on a fresh track (default volume),
  // so the per-track sliders don't change it. Beat 1 is the full level and a little higher; other beats are softer.
  // CLICK_CAL: the click voice's own make-up gain, measured (tests/v9.mjs "metronome level"): with it, a level-0.2 beat-1
  // click is 6 dB under a default-volume Nylon note (K-weighted RMS over the first 100 ms through the real output
  // chain, mean of 8 notes E2..C5). Without it the short tick measured 12.3 dB under, i.e. a quarter, not half.
  var NOTE_PEAK = 0.5, CLICK_SOFT = 0.7, CLICK_CAL = 2.06, clickNoise = null, pend = [];
  function clickLevel() { var M = window.TabModel, dv = M && M.DEFAULT_VOLUME != null ? M.DEFAULT_VOLUME : 80; return 0.5 * NOTE_PEAK * dv / 100; }
  function click(when, accent) {
    var c = ensure(); if (!c) return;
    if (!clickNoise) {
      var len = Math.floor(c.sampleRate * 0.03); clickNoise = c.createBuffer(1, len, c.sampleRate);
      var d = clickNoise.getChannelData(0); for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.sampleRate * 0.004));
    }
    var lvl = clickLevel() * (accent ? 1 : CLICK_SOFT), out = c.createGain();
    out.gain.value = lvl * CLICK_CAL; out.connect(master);
    pend = pend.filter(function (k) { return k.when > c.currentTime; }); pend.push({ out: out, when: when });
    var ns = c.createBufferSource(), bp = c.createBiquadFilter(), ng = c.createGain();
    ns.buffer = clickNoise; bp.type = 'bandpass'; bp.frequency.value = accent ? 2600 : 2000; bp.Q.value = 3.5;
    ng.gain.setValueAtTime(0.9, when); ng.gain.setTargetAtTime(0, when + 0.001, 0.005);
    ns.connect(bp); bp.connect(ng); ng.connect(out); ns.start(when); ns.stop(when + 0.04);
    var o = c.createOscillator(), og = c.createGain();
    o.type = 'sine'; o.frequency.value = accent ? 1250 : 950;
    og.gain.setValueAtTime(0, when); og.gain.linearRampToValueAtTime(0.8, when + 0.001); og.gain.setTargetAtTime(0, when + 0.002, 0.006);
    o.connect(og); og.connect(out); o.start(when); o.stop(when + 0.05);
    return lvl;
  }
  var last = null;
  // Preview one note (fret tap, chord). If the Sound isn't loaded yet it starts loading and this tap stays silent.
  function preview(midi, muted, tone) {
    last = { midi: midi, muted: !!muted, tone: tone || 'nylon' }; unlock(); if (!ctx) return;
    if (!effective(tone || 'nylon')) { load(tone || 'nylon').catch(function () { /* falls back */ }); return; }
    note(midi, ctx.currentTime + 0.01, 0.9, { muted: muted, tone: tone });
  }

  // Scheduler: getSteps() returns [{seconds-free step}] lazily so BPM/edits apply on the next step.
  // v9.1 hand-off (Restart, loop edits, ruler jumps while playing): opts.handoff restarts inside the same lookahead
  // scheduler without a gap. The new first step is placed HANDOFF_LEAD after now (enough for this tick to schedule it);
  // every scheduled note that hasn't started yet is cancelled (disconnected, never sounds), notes already sounding fade
  // out from now (time constant HANDOFF_FADE, under -40 dB by the new downbeat), and clicks queued ahead are dropped.
  // The new steps, their notes and the metronome clicks are all timed from that one AudioContext time, so the downbeat
  // is sample-accurate and nothing from the old pass overlaps it.
  var timer = null, playing = null, voices = [], HANDOFF_LEAD = 0.04, HANDOFF_FADE = 0.006, lastStart = null;
  function play(opts) {
    var handoff = !!(opts.handoff && playing && ctx), at = handoff ? ctx.currentTime + HANDOFF_LEAD : 0;
    var cut = stop({ fade: handoff });
    unlock(); var c = ensure(); if (!c) return false;
    // opts: { count, startAt, stepAt(i) -> {ticks, notes:[{midi, muted, offset (ticks into the step), ticks (length), gain (0-1), track, tone}]}, bpm(), ppq, loop, onStep(i|null), handoff }
    // The caller waits for whenReady(tones) first; a note whose Sound isn't loaded is skipped (never synthesised).
    playing = { opts: opts, i: Math.max(0, Math.min((opts.count || 1) - 1, opts.startAt || 0)), next: handoff ? at : c.currentTime + 0.08, queue: [], raf: 0 };
    lastStart = { at: playing.next, handoff: handoff, now: c.currentTime, voices: cut };
    log = []; clog = [];
    // count-in (v8.2): opts.countIn = { beats, beatTicks } -> one bar of clicks before the first step (accent on 1)
    if (opts.countIn && opts.countIn.beats > 0) {
      var bs = opts.countIn.beatTicks / opts.ppq * 60 / opts.bpm(), ci0 = playing.next;
      for (var b = 0; b < opts.countIn.beats; b++) clog.push({ at: ci0 + b * bs, tick: null, accent: b === 0, countIn: true, gain: +click(ci0 + b * bs, b === 0).toFixed(4) });
      playing.next += opts.countIn.beats * bs;
    }
    t0 = playing.next;
    clog.forEach(function (k) { k.at = +(k.at - t0).toFixed(4); });
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
    if (voices.length > 64) voices = voices.filter(function (v) { return v.stopAt > ctx.currentTime; });
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
        var r = note(n.midi, P.next + (n.offset || 0) * spt, (n.ticks || st.ticks) * spt, { muted: n.muted, gain: gain, tone: n.tone, sched: true });
        if (log.length < 2000) log.push({ midi: n.midi, muted: !!n.muted, at: +(P.next + (n.offset || 0) * spt - t0).toFixed(4), step: P.i, track: n.track == null ? null : n.track, gain: +gain.toFixed(3),
          tone: r ? r.tone : null, sound: r ? r.sound : null });
      });
      (st.clicks || []).forEach(function (k) {
        var at = P.next + k.offset * spt, g = click(at, k.accent);
        if (clog.length < 2000) clog.push({ at: +(at - t0).toFixed(4), tick: k.tick, accent: !!k.accent, gain: +(g || 0).toFixed(4), step: P.i });
      });
      P.queue.push({ t: P.next, i: P.i });
      P.next += secs; P.i++;
    }
  }
  var log = [], clog = [], t0 = 0; // what was scheduled, in seconds from the start of playback (for tests)
  // Stop the scheduler. Notes it scheduled ahead that haven't started are cancelled (so nothing sounds after Stop);
  // notes already sounding ring out naturally, or with o.fade (a hand-off) fade out fast. Returns what it did to each
  // scheduled voice (for tests): { when, stopAt, act: 'cancel' | 'fade' | 'done' }, times in AudioContext seconds.
  function stop(o) {
    if (timer) { clearInterval(timer); timer = null; }
    if (playing) { cancelAnimationFrame(playing.raf); playing = null; }
    var acts = [];
    if (ctx) {
      var now = ctx.currentTime;
      // silence clicks scheduled ahead (the count-in queues a whole bar)
      pend.forEach(function (k) { if (k.when > now) try { k.out.disconnect(); } catch (e) { /* gone */ } });
      voices.forEach(function (v) {
        var a = 'done';
        if (v.stopAt <= now) a = 'done';
        else if (v.when > now) { a = 'cancel'; try { v.g.disconnect(); } catch (e) { /* gone */ } try { v.src.stop(0); } catch (e2) { /* older Safari: one stop() only */ } }
        else if (o && o.fade) {
          a = 'fade'; var gp = v.g.gain;
          if (gp.cancelAndHoldAtTime) gp.cancelAndHoldAtTime(now); else { var cur = gp.value; gp.cancelScheduledValues(now); gp.setValueAtTime(cur, now); }
          gp.setTargetAtTime(0, now, HANDOFF_FADE);
        } else a = 'ring';
        acts.push({ when: +v.when.toFixed(4), stopAt: +v.stopAt.toFixed(4), act: a });
      });
    }
    pend = []; voices = [];
    return acts;
  }
  window.TabAudio = { unlock: unlock, preview: preview, play: play, stop: function () { stop(); }, isPlaying: function () { return !!playing; },
    // v9.1: the last (re)start: AudioContext time of the first step, whether it was a hand-off, and what happened to
    // the notes the previous pass had scheduled (tests)
    lastStart: function () { return lastStart && JSON.parse(JSON.stringify(lastStart)); }, now: function () { return ctx ? ctx.currentTime : 0; }, t0: function () { return t0; },
    lastNote: function () { return last; }, scheduled: function () { return log.slice(); }, clicks: function () { return clog.slice(); },
    clickLevel: function () { return { level: clickLevel(), soft: CLICK_SOFT, notePeak: NOTE_PEAK, defaultTrackGain: 2 * clickLevel() }; }, state: function () { return ctx ? ctx.state : 'none'; },
    // v9 Sounds
    TONE_CACHE: TONE_CACHE, load: load, whenReady: whenReady, isReady: isReady, effective: effective,
    toneState: function (id) { return tones[id] ? tones[id].state : 'idle'; }, onTone: function (f) { listeners.push(f); },
    toneInfo: function (id) { var T = tones[id]; return T && T.state === 'ready' ? { shift: T.shift, gain: T.gain, notes: T.notes.map(function (n) { return { root: n.root, cents: n.cents, len: n.buf.length, sr: n.buf.sampleRate }; }) } : null; },
    toneRequests: function () { return reqLog.slice(); },
    // tests: one note through the real graph (master gain + compressor); n.buf etc. stay private
    _note: function (midi, when, dur, opts) { return note(midi, when, dur, opts); }, _click: function (when, accent) { return click(when, accent); },
    _ctx: function () { return ctx; }, _toneBuf: function (id, i) { var T = tones[id]; return T && T.notes && T.notes[i] ? T.notes[i].buf.getChannelData(0) : null; } };
})();
