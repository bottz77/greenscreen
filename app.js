'use strict';
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

  async function loadSegmenter() {
    const vision = await import(MP_URL + '/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks(MP_URL + '/wasm');
    const make = (delegate) => vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: delegate },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false
    });
    try {
      return await make('GPU');
    } catch (e) {
      console.warn('GPU delegate failed, using CPU', e);
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

  function processFrame() {
    const w = canvas.width, h = canvas.height;
    if (!segmenter) { drawMirrored(ctx, video, w, h); return; }
    const result = segmenter.segmentForVideo(video, performance.now());
    const mask = result.confidenceMasks && result.confidenceMasks[0];
    if (!mask) { drawMirrored(ctx, video, w, h); return; }
    const mw = mask.width, mh = mask.height;
    const conf = mask.getAsFloat32Array();
    if (maskCanvas.width !== mw || maskCanvas.height !== mh || !maskData) {
      maskCanvas.width = mw; maskCanvas.height = mh;
      maskData = maskCtx.createImageData(mw, mh);
    }
    const d = maskData.data;
    for (let i = 0; i < conf.length; i++) d[i * 4 + 3] = conf[i] * 255;
    result.close();
    maskCtx.putImageData(maskData, 0, 0);
    if (personCanvas.width !== w || personCanvas.height !== h) {
      personCanvas.width = w; personCanvas.height = h;
    }
    personCtx.globalCompositeOperation = 'copy';
    drawMirrored(personCtx, maskCanvas, w, h);
    personCtx.globalCompositeOperation = 'source-in';
    drawMirrored(personCtx, video, w, h);
    drawBackground(w, h);
    ctx.drawImage(personCanvas, 0, 0);
  }

  function loop() {
    if (video.readyState >= 2) {
      if (canvas.width !== video.videoWidth) resize();
      processFrame();
    }
    requestAnimationFrame(loop);
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
      statusEl.hidden = false;
      try {
        segmenter = await loadSegmenter();
        statusEl.hidden = true;
      } catch (e) {
        statusEl.textContent = 'Could not load the cut-out model. Check your connection and reload.';
        console.error(e);
      }
    } catch (err) {
      showError(explain(err));
    }
  }

  startBtn.addEventListener('click', start);
})();
