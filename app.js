'use strict';
const APP_VERSION = 'v4';
// Step 1: camera -> canvas draw loop. Later: segmentation inside processFrame().
// Video never leaves the device: no network calls with frames.
(function () {
  const video = document.getElementById('cam');
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const startBtn = document.getElementById('start');
  const errorEl = document.getElementById('error');
  const statusEl = document.getElementById('status');
  const versionEl = document.getElementById('version');
  versionEl.textContent = APP_VERSION;
  window.addEventListener('error', function (e) { setStatus('Error: ' + e.message, true); });
  window.addEventListener('unhandledrejection', function (e) {
    setStatus('Error: ' + (e.reason && e.reason.message ? e.reason.message : e.reason), true);
  });

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    overlay.classList.remove('hidden');
    startBtn.textContent = 'Try again';
    startBtn.disabled = false;
  }

  function explain(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Camera permission was denied. In iPhone Settings > Safari > Camera, choose "Allow" or "Ask", then reload and tap Start.';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No front camera was found on this device.';
      case 'NotReadableError':
        return 'The camera is in use by another app. Close it and try again.';
      default:
        return 'Could not start the camera: ' + (err && err.message ? err.message : String(err));
    }
  }

  function resize() {
    if (!video.videoWidth) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  // --- Step 2: on-device person segmentation (MediaPipe ImageSegmenter) ---
  const MP_VER = '1.1.1';
  const MP_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + MP_VER;
  const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';
  let segmenter = null;
  const maskCanvas = document.createElement('canvas');
  const maskCtx = maskCanvas.getContext('2d');
  const personCanvas = document.createElement('canvas');
  const personCtx = personCanvas.getContext('2d');
  let maskData = null;
  let delegateUsed = '';
  let frameError = null;

  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('error', !!isError);
    statusEl.hidden = false;
  }

  async function loadSegmenter() {
    const vision = await import(MP_URL + '/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks(MP_URL + '/wasm');
    const make = (delegate) => vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: delegate },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false
    });
    // WebKit (all iOS browsers) is unreliable with the GPU delegate; use CPU there.
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isWebKit = isIOS || (/AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent));
    if (isWebKit) { delegateUsed = 'CPU'; return await make('CPU'); }
    try {
      delegateUsed = 'GPU';
      return await make('GPU');
    } catch (e) {
      console.warn('GPU delegate failed, using CPU', e);
      delegateUsed = 'CPU';
      return await make('CPU');
    }
  }

  // Bright runner-game style background: sky, grass, 3-lane track.
  function drawBackground(w, h) {
    const sky = ctx.createLinearGradient(0, 0, 0, h * 0.55);
    sky.addColorStop(0, '#38bdf8');
    sky.addColorStop(1, '#bae6fd');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#4ade80';
    ctx.fillRect(0, h * 0.55, w, h * 0.45);
    const hx = w / 2, hy = h * 0.55;
    ctx.fillStyle = '#a16207';
    ctx.beginPath();
    ctx.moveTo(hx - w * 0.04, hy); ctx.lineTo(hx + w * 0.04, hy);
    ctx.lineTo(w * 0.85, h); ctx.lineTo(w * 0.15, h); ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = Math.max(2, w / 200);
    [-1, 1].forEach(function (k) {
      ctx.beginPath();
      ctx.moveTo(hx + k * w * 0.013, hy);
      ctx.lineTo(w / 2 + k * w * 0.117, h);
      ctx.stroke();
    });
  }

  function drawMirrored(c, src, w, h) {
    c.save();
    c.translate(w, 0);
    c.scale(-1, 1); // mirror like a selfie
    c.drawImage(src, 0, 0, w, h);
    c.restore();
  }

  const params = new URLSearchParams(location.search);
  const DEBUG = params.get('debug') === '1';
  // Small canvas the model reads from (more portable on iOS than passing <video>).
  const inCanvas = document.createElement('canvas');
  const inCtx = inCanvas.getContext('2d', { willReadFrequently: true });
  let source = video; // ?testimg=URL swaps in a still image (testing only)
  let stats = { n: 0, sum: 0, min: 1, max: 0, t: 0, mw: 0, mh: 0, frames: 0 };

  function srcSize() {
    return source === video ? [video.videoWidth, video.videoHeight] : [source.naturalWidth, source.naturalHeight];
  }

  function processFrame() {
    const w = canvas.width, h = canvas.height;
    if (!segmenter || frameError) { drawMirrored(ctx, source, w, h); return; }
    try {
      compositeFrame(w, h);
    } catch (e) {
      frameError = e;
      console.error(e);
      setStatus('Cut-out failed (' + delegateUsed + '): ' + (e && e.message ? e.message : e), true);
      drawMirrored(ctx, source, w, h);
    }
  }

  function compositeFrame(w, h) {
    const sz = srcSize();
    const iw = 256, ih = Math.max(1, Math.round(256 * sz[1] / sz[0]));
    if (inCanvas.width !== iw || inCanvas.height !== ih) { inCanvas.width = iw; inCanvas.height = ih; }
    inCtx.drawImage(source, 0, 0, iw, ih);
    const result = segmenter.segmentForVideo(inCanvas, performance.now());
    const mask = result && result.confidenceMasks && result.confidenceMasks[0];
    if (!mask) { if (result) result.close(); throw new Error('model returned no mask'); }
    const mw = mask.width, mh = mask.height;
    const conf = mask.getAsFloat32Array();
    if (maskCanvas.width !== mw || maskCanvas.height !== mh || !maskData) {
      maskCanvas.width = mw; maskCanvas.height = mh;
      maskData = maskCtx.createImageData(mw, mh);
    }
    const d = maskData.data;
    let sum = 0, mn = 1, mx = 0;
    for (let i = 0; i < conf.length; i++) {
      let c = conf[i];
      c = c > 1 ? 1 : (c > 0 ? c : 0); // clamp (also turns NaN into 0)
      sum += c; if (c < mn) mn = c; if (c > mx) mx = c;
      const j = i * 4;
      d[j] = d[j + 1] = d[j + 2] = 255;
      d[j + 3] = c * 255;
    }
    result.close();
    maskCtx.putImageData(maskData, 0, 0);
    updateStats(mw, mh, sum / conf.length, mn, mx);

    if (DEBUG) { // raw mask: white = person, black = background
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      drawMirrored(ctx, maskCanvas, w, h);
      return;
    }
    if (personCanvas.width !== w || personCanvas.height !== h) {
      personCanvas.width = w; personCanvas.height = h;
    }
    // Person layer: clear, draw camera, keep only where the mask is opaque.
    personCtx.globalCompositeOperation = 'source-over';
    personCtx.clearRect(0, 0, w, h);
    drawMirrored(personCtx, source, w, h);
    personCtx.globalCompositeOperation = 'destination-in';
    drawMirrored(personCtx, maskCanvas, w, h);
    personCtx.globalCompositeOperation = 'source-over';
    // Main canvas: background, then person on top.
    ctx.globalCompositeOperation = 'source-over';
    drawBackground(w, h);
    ctx.drawImage(personCanvas, 0, 0);
  }

  function updateStats(mw, mh, mean, mn, mx) {
    stats.frames++;
    stats.sum += mean; stats.n++;
    stats.min = Math.min(stats.min, mn); stats.max = Math.max(stats.max, mx);
    const now = performance.now();
    if (now - stats.t < 1000) return;
    versionEl.textContent = APP_VERSION + ' · ' + delegateUsed + ' · mask ' + mw + 'x' + mh +
      ' · mean ' + (stats.sum / stats.n).toFixed(2) + ' [' + stats.min.toFixed(2) + '–' + stats.max.toFixed(2) + ']' +
      ' · ' + Math.round(stats.frames * 1000 / (now - stats.t || 1)) + 'fps' + (DEBUG ? ' · debug' : '');
    stats = { n: 0, sum: 0, min: 1, max: 0, t: now, mw: mw, mh: mh, frames: 0 };
  }

  function loop() {
    const ready = source === video ? video.readyState >= 2 : source.complete;
    if (ready) {
      const sz = srcSize();
      if (canvas.width !== sz[0] || canvas.height !== sz[1]) { canvas.width = sz[0]; canvas.height = sz[1]; }
      processFrame();
    }
    requestAnimationFrame(loop);
  }

  async function startModel() {
    setStatus('Loading model…');
    try {
      segmenter = await loadSegmenter();
      statusEl.hidden = true;
      versionEl.textContent = APP_VERSION + ' · ' + delegateUsed;
    } catch (e) {
      console.error(e);
      setStatus('Could not load the cut-out model: ' + (e && e.message ? e.message : e), true);
    }
  }

  async function start() {
    errorEl.hidden = true;
    if (!window.isSecureContext) {
      showError('The camera only works on a secure (https) page.');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('This browser does not support camera access. Use Safari on iOS 14.3 or newer.');
      return;
    }
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      video.srcObject = stream;
      await video.play();
      resize();
      overlay.classList.add('hidden');
      requestAnimationFrame(loop);
      await startModel();
    } catch (err) {
      showError(explain(err));
    }
  }

  startBtn.addEventListener('click', function () {
    const testImg = params.get('testimg');
    if (!testImg) { start(); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () { source = img; overlay.classList.add('hidden'); requestAnimationFrame(loop); startModel(); };
    img.onerror = function () { showError('Could not load test image.'); };
    img.src = testImg;
  });
})();
