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

  // Hook for later steps (segmentation / background replace).
  function processFrame() {
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1); // mirror like a selfie
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();
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
    } catch (err) {
      showError(explain(err));
    }
  }

  startBtn.addEventListener('click', start);
})();
