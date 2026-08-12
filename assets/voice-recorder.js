/* ============================================================
   Urban Farms — Global Voice Note Recorder
   A reusable, floating voice recorder available on all pages.
   Records / plays / retakes a single voice note and exposes it
   globally so any flow (shop registration, BE verification,
   delivery, visits) can read the recorded blob.

   Global API:
     window.UFVoice = {
       hasBlob()          -> boolean
       getBlob()          -> Blob | null
       getDataUrl()       -> Promise<string | null>
       clear()            -> void
       open()             -> void
       close()            -> void
       onReady(cb)        -> fire cb(blob) when a note is recorded
     }
   ============================================================ */
(function () {
  if (window.__UFVoiceLoaded) return;
  window.__UFVoiceLoaded = true;

  var blob = null;
  var blobUrl = null;
  var recorder = null;
  var chunks = [];
  var recording = false;
  var stream = null;
  var readyCallbacks = [];

  function onReady(cb) { if (typeof cb === 'function') readyCallbacks.push(cb); }
  function fireReady() { var cb; while ((cb = readyCallbacks.shift())) { try { cb(blob); } catch (e) {} } }

  function hasBlob() { return !!blob; }
  function getBlob() { return blob; }
  function clear() {
    stopRecorder();
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    blob = null;
    if (widget) updateWidget();
  }

  function getDataUrl() {
    return new Promise(function (resolve, reject) {
      if (!blob) return resolve(null);
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('Failed to read voice note')); };
      reader.readAsDataURL(blob);
    });
  }

  function supports() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  function stopRecorder() {
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (e) {} }
    recorder = null;
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  }

  function startRecording() {
    if (!supports()) { setStatus('Voice recording not supported on this device.'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (s) {
        stream = s;
        chunks = [];
        recorder = new MediaRecorder(s);
        recorder.ondataavailable = function (e) { if (e.data && e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          stream = null;
          var type = recorder && recorder.mimeType ? recorder.mimeType : 'audio/webm';
          var newBlob = new Blob(chunks, { type: type });
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          blobUrl = URL.createObjectURL(newBlob);
          blob = newBlob;
          recording = false;
          updateWidget();
          fireReady();
        };
        recorder.start();
        recording = true;
        updateWidget();
      })
      .catch(function () { setStatus('Microphone access is required.'); });
  }

  function stopRecording() {
    if (recorder && recorder.state === 'recording') recorder.stop();
  }

  function toggleRecording() {
    if (recording) stopRecording(); else startRecording();
  }

  function playPreview() {
    if (!blobUrl) return;
    var a = new Audio(blobUrl);
    a.play();
  }

  /* ---------- Widget DOM ---------- */
  var widget = null;
  var statusEl = null;

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

  function buildWidget() {
    var host = document.createElement('div');
    host.id = 'uf-voice-recorder';
    host.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;font-family:system-ui,-apple-system,Segoe UI,sans-serif;';

    // Floating launch button
    var fab = document.createElement('button');
    fab.id = 'uf-voice-fab';
    fab.textContent = '🎙️ Voice Note';
    fab.setAttribute('aria-label', 'Open voice note recorder');
    fab.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:12px 18px;border-radius:100px;border:none;cursor:pointer;background:linear-gradient(135deg,#9C3A22,#C1552E);color:#fff;font-weight:700;font-size:0.85rem;box-shadow:0 10px 24px -8px rgba(156,58,34,0.6);transition:transform .25s ease, box-shadow .25s ease;';
    fab.addEventListener('mouseenter', function () { fab.style.transform = 'translateY(-2px)'; });
    fab.addEventListener('mouseleave', function () { fab.style.transform = 'translateY(0)'; });
    fab.addEventListener('click', open);

    // Panel
    var panel = document.createElement('div');
    panel.id = 'uf-voice-panel';
    panel.style.cssText = 'display:none;position:absolute;bottom:64px;right:0;width:300px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 30px 60px -15px rgba(18,32,16,0.4);border:1px solid rgba(33,29,21,0.06);';

    panel.innerHTML =
      '<div style="background:linear-gradient(160deg,#122010,#1E3420);padding:16px 18px;">' +
      '  <div style="font-weight:800;font-size:0.95rem;color:#fff;">🎙️ Voice Note</div>' +
      '  <div style="font-size:0.72rem;color:rgba(247,241,225,0.7);margin-top:2px;">Record, play &amp; share your voice note</div>' +
      '</div>' +
      '<div style="padding:16px 18px;">' +
      '  <div id="uf-voice-status" style="font-size:0.82rem;color:#5a5646;margin-bottom:12px;min-height:18px;">Not recorded</div>' +
      '  <div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      '    <button id="uf-voice-record" style="flex:1;padding:10px;border-radius:100px;border:none;cursor:pointer;font-weight:700;font-size:0.85rem;background:linear-gradient(135deg,#9C3A22,#C1552E);color:#fff;">🎙️ Record</button>' +
      '    <button id="uf-voice-play" style="flex:1;padding:10px;border-radius:100px;border:1.5px solid #9C3A22;cursor:pointer;font-weight:700;font-size:0.85rem;background:#fff;color:#9C3A22;display:none;">▶️ Play</button>' +
      '  </div>' +
      '  <div style="display:flex;gap:8px;margin-top:8px;">' +
      '    <button id="uf-voice-retake" style="flex:1;padding:9px;border-radius:100px;border:1.5px solid rgba(33,29,21,0.12);cursor:pointer;font-weight:600;font-size:0.8rem;background:#FBF8EF;color:#211D15;display:none;">↺ Retake</button>' +
      '    <button id="uf-voice-clear" style="flex:1;padding:9px;border-radius:100px;border:1.5px solid rgba(33,29,21,0.12);cursor:pointer;font-weight:600;font-size:0.8rem;background:#FBF8EF;color:#211D15;">🗑️ Clear</button>' +
      '  </div>' +
      '  <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(33,29,21,0.06);display:flex;justify-content:flex-end;">' +
      '    <button id="uf-voice-close" style="padding:8px 16px;border-radius:100px;border:none;cursor:pointer;font-weight:700;font-size:0.8rem;background:#1E3420;color:#fff;">Done</button>' +
      '  </div>' +
      '</div>';

    host.appendChild(panel);
    host.appendChild(fab);
    document.body.appendChild(host);

    document.getElementById('uf-voice-record').addEventListener('click', function () {
      if (recording) { stopRecording(); this.textContent = '🎙️ Record'; }
      else { startRecording(); this.textContent = '⏹️ Stop'; }
    });
    document.getElementById('uf-voice-play').addEventListener('click', playPreview);
    document.getElementById('uf-voice-retake').addEventListener('click', function () { clear(); startRecording(); });
    document.getElementById('uf-voice-clear').addEventListener('click', clear);
    document.getElementById('uf-voice-close').addEventListener('click', close);

    widget = panel;
    statusEl = document.getElementById('uf-voice-status');
    updateWidget();
  }

  function updateWidget() {
    if (!widget) return;
    var recordBtn = document.getElementById('uf-voice-record');
    var playBtn = document.getElementById('uf-voice-play');
    var retakeBtn = document.getElementById('uf-voice-retake');
    if (recording) {
      recordBtn.textContent = '⏹️ Stop';
      statusEl.textContent = 'Recording…';
    } else if (blob) {
      recordBtn.textContent = '🎙️ Record Again';
      playBtn.style.display = 'inline-flex';
      retakeBtn.style.display = 'inline-flex';
      statusEl.textContent = '✅ Voice note recorded';
    } else {
      recordBtn.textContent = '🎙️ Record';
      playBtn.style.display = 'none';
      retakeBtn.style.display = 'none';
      statusEl.textContent = 'Not recorded';
    }
  }

  function open() {
    if (!widget) buildWidget();
    widget.style.display = 'block';
    updateWidget();
  }
  function close() {
    if (widget) widget.style.display = 'none';
  }

  window.UFVoice = {
    hasBlob: hasBlob,
    getBlob: getBlob,
    getDataUrl: getDataUrl,
    clear: clear,
    open: open,
    close: close,
    onReady: onReady
  };

  buildWidget();
})();
