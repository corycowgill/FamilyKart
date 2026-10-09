/*!
 * Hallucinated Games - Studio Intro
 * A logo that hallucinates itself out of noise. No dependencies, one file.
 *
 *   <script src="intro/hallucinated-intro.js"></script>
 *   HallucinatedIntro.play().then(startGame);
 *
 * Options (all optional):
 *   canvas      existing canvas to draw into; omitted = fullscreen overlay
 *   skippable   click/tap/any key ends it early (default true)
 *   tagline     text under the mark; '' hides it
 *   sound       procedural WebAudio sting (default false; needs a user gesture)
 *   quality     'high' | 'low' - 'low' drops the per-frame static field
 *   onSkip      called if the viewer skipped
 *
 * Rendering is deterministic: renderFrame(ctx, t, w, h) draws the exact same
 * pixels for a given t, which is how tools/render-frames.html captures the mp4.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HallucinatedIntro = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Design space. Everything is authored at 1920x1080 and letterboxed to fit
     whatever canvas it is handed, so a phone and a 4K monitor agree. */
  var W = 1920, H = 1080;
  var DURATION = 4.6;

  var FONT_DISPLAY = '"Orbitron", "Arial Black", "Impact", sans-serif';
  var FONT_TEXT = '"Rajdhani", "Trebuchet MS", sans-serif';

  var GREEN = [0, 255, 170];
  var PURPLE = [123, 97, 255];
  var SPARKS = ['#00ffaa', '#7b61ff', '#ffd700', '#ff6b35', '#5599ff'];
  var SPARKS_RGB = [[0, 255, 170], [123, 97, 255], [255, 215, 0], [255, 107, 53], [85, 153, 255]];

  var DEFAULT_TAGLINE = '100% VIBE CODED · 0% UNIT TESTED';

  /* ---------- small math helpers ---------- */

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* Normalised 0..1 progress of t across [a,b]. */
  function span(t, a, b) { return clamp((t - a) / (b - a), 0, 1); }

  function lerp(a, b, k) { return a + (b - a) * k; }
  function easeOutCubic(k) { return 1 - Math.pow(1 - k, 3); }
  function easeInCubic(k) { return k * k * k; }
  function smoothstep(k) { return k * k * (3 - 2 * k); }

  /* Seeded PRNG - the static has to be reproducible or the video renderer
     would produce a different flicker on every pass. */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

  /* ---------- text drawn with manual letter tracking ----------
     ctx.letterSpacing is not universally supported, so glyphs are advanced by
     hand. That also gives exact measurement for free. */

  function measureTracked(ctx, text, spacing) {
    var w = 0;
    for (var i = 0; i < text.length; i++) w += ctx.measureText(text[i]).width;
    return w + spacing * (text.length - 1);
  }

  function drawTracked(ctx, text, cx, y, spacing) {
    var x = cx - measureTracked(ctx, text, spacing) / 2;
    var prev = ctx.textAlign;
    ctx.textAlign = 'left';
    for (var i = 0; i < text.length; i++) {
      ctx.fillText(text[i], x, y);
      x += ctx.measureText(text[i]).width + spacing;
    }
    ctx.textAlign = prev;
  }

  /* ---------- the wordmark, pre-rendered once ---------- */

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* Isolate one RGB channel of src into its own canvas, preserving alpha.
     Used for the chromatic split - built once, then just drawn at an offset. */
  function channelCopy(src, color) {
    var c = makeCanvas(src.width, src.height);
    var x = c.getContext('2d');
    x.drawImage(src, 0, 0);
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = color;
    x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = 'destination-in'; // multiply flattened the alpha
    x.drawImage(src, 0, 0);
    return c;
  }

  var LINE1 = 'HALLUCINATED';
  var LINE2 = 'GAMES';
  var Y1 = 468, Y2 = 622;

  function buildMark() {
    var c = makeCanvas(W, H);
    var x = c.getContext('2d');
    x.textBaseline = 'middle';

    /* Line 1 sets the lockup width; line 2 is tracked out to match it. */
    x.font = '900 150px ' + FONT_DISPLAY;
    var w1 = measureTracked(x, LINE1, 10);
    var bare2 = measureTracked(x, LINE2, 0);
    var track2 = (w1 - bare2) / (LINE2.length - 1);

    var grad = x.createLinearGradient(W / 2 - w1 / 2, 0, W / 2 + w1 / 2, 0);
    /* The site's h1 gradient, with the white stop pulled in tight so it reads
       as a highlight instead of washing out the first four letters. */
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.18, '#00ffaa');
    grad.addColorStop(0.62, '#7b61ff');
    grad.addColorStop(1, '#ffd700');
    x.fillStyle = grad;

    x.shadowColor = 'rgba(0,255,170,0.55)';
    x.shadowBlur = 38;
    drawTracked(x, LINE1, W / 2, Y1, 10);
    drawTracked(x, LINE2, W / 2, Y2, track2);
    x.shadowBlur = 0;

    return { canvas: c, width: w1 };
  }

  /* Sample the mark's opaque pixels - these are the particle destinations. */
  function sampleTargets(markCanvas, maxPoints, rnd) {
    var x = markCanvas.getContext('2d');
    var data = x.getImageData(0, 0, W, H).data;
    var pts = [];
    var step = 4;
    for (var y = 0; y < H; y += step) {
      for (var px = 0; px < W; px += step) {
        if (data[(y * W + px) * 4 + 3] > 140) pts.push(px, y);
      }
    }
    /* Shuffle pairs before trimming, so the cap keeps an even spread across all
       the glyphs instead of biasing toward whichever letters scan first. */
    var n = pts.length / 2;
    for (var i = n - 1; i > 0; i--) {
      var j = (rnd() * (i + 1)) | 0;
      var ax = pts[i * 2], ay = pts[i * 2 + 1];
      pts[i * 2] = pts[j * 2]; pts[i * 2 + 1] = pts[j * 2 + 1];
      pts[j * 2] = ax; pts[j * 2 + 1] = ay;
    }
    if (n > maxPoints) pts.length = maxPoints * 2;
    return pts;
  }

  function buildParticles(targets, rnd) {
    var n = targets.length / 2;
    var p = {
      n: n,
      tx: new Float32Array(n), ty: new Float32Array(n),
      ox: new Float32Array(n), oy: new Float32Array(n),
      delay: new Float32Array(n), wob: new Float32Array(n),
      hue: new Uint8Array(n), size: new Float32Array(n)
    };
    for (var i = 0; i < n; i++) {
      p.tx[i] = targets[i * 2];
      p.ty[i] = targets[i * 2 + 1];
      /* Start spread across the whole frame, like a field of static. A ring
         scatter put most of them off-canvas and the opening read as empty. */
      p.ox[i] = -0.1 * W + rnd() * W * 1.2;
      p.oy[i] = -0.1 * H + rnd() * H * 1.2;
      p.delay[i] = rnd() * 0.42;          // staggered arrival
      p.wob[i] = rnd() * Math.PI * 2;
      p.hue[i] = (rnd() * SPARKS.length) | 0;
      p.size[i] = 1 + rnd() * 1.6;
    }
    return p;
  }

  /* ---------- one-time scene build ---------- */

  var scene = null;

  function getScene() {
    if (scene) return scene;
    var rnd = mulberry32(0x5EED);
    var mark = buildMark();
    var targets = sampleTargets(mark.canvas, 9000, rnd);
    scene = {
      mark: mark.canvas,
      markWidth: mark.width,
      r: channelCopy(mark.canvas, '#ff0000'),
      g: channelCopy(mark.canvas, '#00ff00'),
      b: channelCopy(mark.canvas, '#0000ff'),
      particles: buildParticles(targets, rnd)
    };
    return scene;
  }

  /* Fonts must resolve before the mark is rasterised, otherwise the particle
     targets get baked from the fallback face. */
  function ensureFonts() {
    if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
    if (!document.querySelector('link[data-hg-fonts]')) {
      var l = document.createElement('link');
      l.rel = 'stylesheet';
      l.setAttribute('data-hg-fonts', '');
      l.href = 'https://fonts.googleapis.com/css2?family=Orbitron:wght@900&family=Rajdhani:wght@600&display=swap';
      document.head.appendChild(l);
    }
    var wait = Promise.all([
      document.fonts.load('900 150px Orbitron'),
      document.fonts.load('600 40px Rajdhani')
    ]).catch(function () {});
    /* Never let a slow or offline CDN hold the game hostage - fall back and go. */
    return Promise.race([wait, new Promise(function (r) { setTimeout(r, 1500); })]);
  }

  /* ---------- frame rendering ---------- */

  var PHASE = {
    voidEnd: 0.55,
    denoise: [0.35, 2.05],
    markIn: [1.70, 2.35],
    glitch: [2.20, 2.55],
    flash: 2.30,
    tagline: [2.55, 3.25],
    fade: [4.05, 4.60]
  };

  function drawBackdrop(ctx, t) {
    ctx.fillStyle = '#07070c';
    ctx.fillRect(0, 0, W, H);

    /* The site's drifting grid, very faint. */
    var drift = (t * 26) % 60;
    ctx.strokeStyle = 'rgba(0,255,170,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var gx = -60 + drift; gx < W; gx += 60) { ctx.moveTo(gx, 0); ctx.lineTo(gx, H); }
    for (var gy = -60 + drift; gy < H; gy += 60) { ctx.moveTo(0, gy); ctx.lineTo(W, gy); }
    ctx.stroke();
  }

  /* Untamed static, thinning out as the picture resolves.
     Drawn into a small buffer and upscaled with smoothing off, so it reads as
     chunky CRT noise. Scattering a few thousand 1px rects across 1080p just
     produced a faint grey wash. */
  var noiseBuf = null, noiseImg = null;
  var NW = 320, NH = 180;

  function drawStatic(ctx, amount, rnd) {
    if (amount <= 0.004) return;
    if (!noiseBuf) {
      noiseBuf = makeCanvas(NW, NH);
      noiseImg = noiseBuf.getContext('2d').createImageData(NW, NH);
    }
    var d = noiseImg.data;
    var density = 0.12 + 0.5 * amount;
    for (var i = 0; i < NW * NH; i++) {
      var o = i * 4;
      if (rnd() >= density) { d[o + 3] = 0; continue; }
      var v = 120 + rnd() * 135;
      if (rnd() < 0.84) {
        d[o] = v; d[o + 1] = v; d[o + 2] = v;
      } else {
        var c = SPARKS_RGB[(rnd() * SPARKS_RGB.length) | 0];
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2];
      }
      d[o + 3] = (100 + rnd() * 140) * amount;
    }
    noiseBuf.getContext('2d').putImageData(noiseImg, 0, 0);

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.9;
    ctx.drawImage(noiseBuf, 0, 0, W, H);
    ctx.restore();
  }

  function drawParticles(ctx, t, p, scale, stride) {
    var base = span(t, PHASE.denoise[0], PHASE.denoise[1]);
    if (base <= 0) return;

    /* Sizes are in design units, so on a small canvas a 1px dot scales to a
       fraction of a device pixel and disappears. Hold a floor of ~1.2 real px. */
    var floor = 1.2 / scale;

    /* Once the crisp mark is up the dust recedes rather than double-exposing. */
    var recede = span(t, PHASE.markIn[0], PHASE.markIn[1] + 0.15);
    var fieldAlpha = 1 - 0.82 * recede;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (var i = 0; i < p.n; i += stride) {
      var k = clamp((base - p.delay[i]) / (1 - p.delay[i]), 0, 1);
      if (k <= 0) continue;
      var e = easeOutCubic(k);
      var sz = Math.max(p.size[i], floor);

      /* Jitter is the "noise" - it decays as the sample denoises. */
      var jit = (1 - k) * (1 - k) * 170;
      var wob = p.wob[i] + t * 3.1;
      var x = lerp(p.ox[i], p.tx[i], e) + Math.cos(wob) * jit;
      var y = lerp(p.oy[i], p.ty[i], e) + Math.sin(wob * 1.3) * jit;

      /* Colour anneals from random palette sparks to the mark's gradient. */
      var tone = p.tx[i] / W;
      var fin = [
        lerp(GREEN[0], PURPLE[0], tone) | 0,
        lerp(GREEN[1], PURPLE[1], tone) | 0,
        lerp(GREEN[2], PURPLE[2], tone) | 0
      ];
      var a = (0.42 + 0.58 * k) * fieldAlpha;

      if (k < 0.6) {
        /* Early on they are loose palette sparks; they anneal to the mark's
           own gradient as they land. Cross-fade between the two. */
        ctx.fillStyle = SPARKS[p.hue[i]];
        ctx.globalAlpha = a * (1 - k / 0.6);
        ctx.fillRect(x, y, sz + 0.6, sz + 0.6);
        ctx.globalAlpha = a * (k / 0.6);
      } else {
        ctx.globalAlpha = a;
      }
      ctx.fillStyle = rgba(fin, 1);
      ctx.fillRect(x, y, sz, sz);
    }
    ctx.restore();
  }

  /* Horizontal tear bands during the lock-in snap. Sorted and non-overlapping
     so the band-by-band redraw below stays in order. */
  function glitchSlices(t, rnd) {
    var g = span(t, PHASE.glitch[0], PHASE.glitch[1]);
    if (g <= 0 || g >= 1) return null;
    var energy = Math.sin(g * Math.PI); // ramps up then back down
    var bands = [];
    var count = 3 + ((rnd() * 4) | 0);
    for (var i = 0; i < count; i++) {
      bands.push({
        y: rnd() * H,
        h: 10 + rnd() * 70,
        dx: (rnd() - 0.5) * 210 * energy
      });
    }
    bands.sort(function (a, b) { return a.y - b.y; });
    var out = [], cursor = 0;
    for (var j = 0; j < bands.length; j++) {
      if (bands[j].y < cursor) continue;          // drop overlaps
      if (bands[j].y + bands[j].h > H) continue;
      out.push(bands[j]);
      cursor = bands[j].y + bands[j].h;
    }
    return out.length ? out : null;
  }

  function drawMark(ctx, t, s, rnd) {
    var alpha = span(t, PHASE.markIn[0], PHASE.markIn[1]);
    if (alpha <= 0) return;
    alpha = smoothstep(alpha);

    /* Aberration collapses as the mark settles, with a kick during the glitch. */
    var ab = (1 - span(t, PHASE.markIn[0], PHASE.markIn[1])) * 26;
    var g = span(t, PHASE.glitch[0], PHASE.glitch[1]);
    if (g > 0 && g < 1) ab += Math.sin(g * Math.PI) * 9;

    var bands = glitchSlices(t, rnd);

    function stamp(img, dx) {
      if (!bands) { ctx.drawImage(img, dx, 0); return; }
      var prevY = 0;
      for (var i = 0; i < bands.length; i++) {
        var b = bands[i];
        if (b.y > prevY) ctx.drawImage(img, 0, prevY, W, b.y - prevY, dx, prevY, W, b.y - prevY);
        ctx.drawImage(img, 0, b.y, W, b.h, dx + b.dx, b.y, W, b.h);
        prevY = b.y + b.h;
      }
      if (prevY < H) ctx.drawImage(img, 0, prevY, W, H - prevY, dx, prevY, W, H - prevY);
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    if (ab > 0.4) {
      ctx.globalCompositeOperation = 'lighter';
      stamp(s.r, -ab);
      stamp(s.g, 0);
      stamp(s.b, ab);
    } else {
      stamp(s.mark, 0);
      /* Additive pass once it is locked - the neon should feel lit, not printed. */
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * 0.45;
      stamp(s.mark, 0);
    }
    ctx.restore();
  }

  function drawTagline(ctx, t, text, markWidth) {
    if (!text) return;
    var a = span(t, PHASE.tagline[0], PHASE.tagline[1]);
    if (a <= 0) return;
    a = smoothstep(a);

    ctx.save();
    ctx.globalAlpha = a;
    ctx.textBaseline = 'middle';
    ctx.font = '600 38px ' + FONT_TEXT;
    ctx.fillStyle = 'rgba(190,200,215,0.92)';
    drawTracked(ctx, text, W / 2, 742, 7);

    /* Rule that wipes outward above the tagline. */
    var lw = markWidth * 0.62 * a;
    var grad = ctx.createLinearGradient(W / 2 - lw / 2, 0, W / 2 + lw / 2, 0);
    grad.addColorStop(0, 'rgba(0,255,170,0)');
    grad.addColorStop(0.5, 'rgba(0,255,170,0.75)');
    grad.addColorStop(1, 'rgba(0,255,170,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(W / 2 - lw / 2, 700, lw, 2);
    ctx.restore();
  }

  function drawOverlays(ctx, t) {
    /* Scanlines. */
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#000';
    for (var y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 2);
    ctx.restore();

    /* Lock-in flash. */
    if (t >= PHASE.flash) {
      var f = 1 - span(t, PHASE.flash, PHASE.flash + 0.22);
      if (f > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(190,255,230,' + (f * f * 0.5) + ')';
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    }

    /* Vignette. */
    var v = ctx.createRadialGradient(W / 2, H / 2, H * 0.22, W / 2, H / 2, H * 0.82);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.78)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);

    /* Fade to black. */
    var fo = span(t, PHASE.fade[0], PHASE.fade[1]);
    if (fo > 0) {
      ctx.fillStyle = 'rgba(0,0,0,' + easeInCubic(fo) + ')';
      ctx.fillRect(0, 0, W, H);
    }
  }

  /* Draws the whole frame at time t into a ctx of size w x h. */
  function renderFrame(ctx, t, w, h, opts) {
    opts = opts || {};
    var s = getScene();
    /* Seed off the quantised frame time so playback and capture agree. */
    var rnd = mulberry32((((t * 1000) | 0) * 1103515245 + 12345) | 0);

    var scale = Math.min(w / W, h / H);
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.translate((w - W * scale) / 2, (h - H * scale) / 2);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    drawBackdrop(ctx, t);

    var noiseAmt = t < PHASE.voidEnd
      ? span(t, 0, PHASE.voidEnd)
      : 1 - span(t, PHASE.denoise[0], PHASE.denoise[1] - 0.15);
    var low = opts.quality === 'low';
    if (!low) drawStatic(ctx, Math.max(0, noiseAmt), rnd);

    drawParticles(ctx, t, s.particles, scale, low ? 3 : 1);
    drawMark(ctx, t, s, rnd);
    drawTagline(ctx, t, opts.tagline == null ? DEFAULT_TAGLINE : opts.tagline, s.markWidth);
    drawOverlays(ctx, t);

    ctx.restore();
  }

  /* ---------- procedural audio sting ---------- */

  function playSting(ac) {
    var now = ac.currentTime + 0.02;
    var master = ac.createGain();
    master.gain.value = 0.9;
    master.connect(ac.destination);

    /* Riser: sawtooth sweeping up into the lock. */
    var riseOsc = ac.createOscillator();
    var riseGain = ac.createGain();
    var riseFilt = ac.createBiquadFilter();
    riseOsc.type = 'sawtooth';
    riseFilt.type = 'lowpass';
    riseOsc.frequency.setValueAtTime(70, now);
    riseOsc.frequency.exponentialRampToValueAtTime(880, now + 2.28);
    riseFilt.frequency.setValueAtTime(220, now);
    riseFilt.frequency.exponentialRampToValueAtTime(5200, now + 2.28);
    riseGain.gain.setValueAtTime(0.0001, now);
    riseGain.gain.exponentialRampToValueAtTime(0.16, now + 2.2);
    riseGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.42);
    riseOsc.connect(riseFilt); riseFilt.connect(riseGain); riseGain.connect(master);
    riseOsc.start(now); riseOsc.stop(now + 2.5);

    /* Impact on the lock-in flash. */
    var hit = now + 2.3;
    var sub = ac.createOscillator();
    var subGain = ac.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(150, hit);
    sub.frequency.exponentialRampToValueAtTime(42, hit + 0.5);
    subGain.gain.setValueAtTime(0.9, hit);
    subGain.gain.exponentialRampToValueAtTime(0.0001, hit + 1.1);
    sub.connect(subGain); subGain.connect(master);
    sub.start(hit); sub.stop(hit + 1.2);

    /* Bright shimmer chord over the reveal. */
    [523.25, 784.0, 1046.5].forEach(function (f, i) {
      var o = ac.createOscillator(), g = ac.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, hit);
      g.gain.exponentialRampToValueAtTime(0.09 / (i + 1), hit + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, hit + 1.5);
      o.connect(g); g.connect(master);
      o.start(hit); o.stop(hit + 1.6);
    });

    /* Noise sweep riding the riser. */
    var len = Math.floor(ac.sampleRate * 2.5);
    var buf = ac.createBuffer(1, len, ac.sampleRate);
    var ch = buf.getChannelData(0);
    for (var i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(i / len, 2);
    var src = ac.createBufferSource();
    var nGain = ac.createGain();
    var nFilt = ac.createBiquadFilter();
    nFilt.type = 'bandpass';
    nFilt.frequency.setValueAtTime(400, now);
    nFilt.frequency.exponentialRampToValueAtTime(7000, now + 2.3);
    nGain.gain.setValueAtTime(0.16, now);
    nGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.45);
    src.buffer = buf;
    src.connect(nFilt); nFilt.connect(nGain); nGain.connect(master);
    src.start(now);
  }

  /* ---------- playback ---------- */

  function play(opts) {
    opts = opts || {};
    var skippable = opts.skippable !== false;

    return ensureFonts().then(function () {
      return new Promise(function (resolve) {
        var canvas = opts.canvas;
        var overlay = null;

        if (!canvas) {
          overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#000;' +
            'display:flex;align-items:center;justify-content:center;cursor:pointer';
          canvas = document.createElement('canvas');
          canvas.style.cssText = 'width:100%;height:100%;display:block';
          overlay.appendChild(canvas);
          document.body.appendChild(overlay);
        }

        var ctx = canvas.getContext('2d');
        var dpr = Math.min(window.devicePixelRatio || 1, 2);

        function size() {
          var r = canvas.getBoundingClientRect();
          if (!r.width || !r.height) return;
          canvas.width = Math.max(1, Math.round(r.width * dpr));
          canvas.height = Math.max(1, Math.round(r.height * dpr));
        }
        if (overlay) { size(); window.addEventListener('resize', size); }
        else if (!canvas.width) size();

        /* Rasterise the mark and build the particle field before the clock
           starts - otherwise that ~70ms lands on frame one as a visible hitch. */
        getScene();

        var reduced = window.matchMedia &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        var ac = null;
        if (opts.sound) {
          try {
            ac = new (window.AudioContext || window.webkitAudioContext)();
            if (ac.state === 'suspended') ac.resume();
            playSting(ac);
          } catch (e) { /* autoplay blocked - run silent */ }
        }

        var raf = 0;
        var done = false;

        function finish(skipped) {
          if (done) return;
          done = true;
          cancelAnimationFrame(raf);
          window.removeEventListener('resize', size);
          if (skippable) {
            window.removeEventListener('keydown', onSkip);
            window.removeEventListener('pointerdown', onSkip);
          }
          if (ac) { try { ac.close(); } catch (e) {} }
          if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
          if (skipped && opts.onSkip) opts.onSkip();
          resolve({ skipped: !!skipped });
        }
        function onSkip() { finish(true); }

        if (skippable) {
          window.addEventListener('keydown', onSkip);
          window.addEventListener('pointerdown', onSkip);
        }

        /* Reduced motion: hold the resolved logo, skip the strobe entirely. */
        if (reduced) {
          renderFrame(ctx, 3.6, canvas.width, canvas.height, opts);
          setTimeout(function () { finish(false); }, 1600);
          return;
        }

        var start = performance.now();
        (function frame(now) {
          var t = (now - start) / 1000;
          if (t >= DURATION) { finish(false); return; }
          renderFrame(ctx, t, canvas.width, canvas.height, opts);
          raf = requestAnimationFrame(frame);
        })(start);
      });
    });
  }

  return {
    play: play,
    renderFrame: renderFrame,
    DURATION: DURATION,
    WIDTH: W,
    HEIGHT: H,
    ensureFonts: ensureFonts
  };
}));
