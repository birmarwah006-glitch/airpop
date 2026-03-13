// gesture.js — AirPop Live
//
// Loaded AFTER index.html's client script, so these globals are available:
//   write(msg, type)       — log helper
//   gestureState           — { filesReady: bool }
//   gestureSendFiles()     — sends staged files then resets state
//   dropZone               — the #dropZone element
//   fileInput              — the #fileInput element
//
// MediaPipe scripts (hands + camera_utils) are loaded in index.html <head>.
// The locateFile path below MUST match those exact pinned CDN versions.

(function () {

  /* =========================================================
     CONFIG
     ========================================================= */
  var CFG = {
    minDetection:    0.70,
    minTracking:     0.50,
    smoothing:       0.55,   // 0 = raw, 1 = never moves
    grabFrames:      4,      // frames fist must be held before grab triggers
    sendFrames:      3,      // frames open-fist must be held before send triggers
    pushZThreshold:  0.045,  // how much wrist Z must drop to count as a push
    pushResetFrames: 10,     // cooldown frames after a push
    doublePushMs:    800     // max ms between two pushes to count as double
  };

  /* =========================================================
     STATE  (all private inside IIFE)
     ========================================================= */
  var running      = false;  // true while MediaPipe loop is active
  var gx = 0, gy   = 0;     // smoothed cursor position
  var grabCount    = 0;
  var sendCount    = 0;
  var isGrabbing   = false;
  var hasSent      = false;
  var lastWristZ   = null;
  var pushCooldown = 0;
  var firstPushAt  = null;
  var pushCount    = 0;
  var pushTimer    = null;

  /* =========================================================
     HELPERS
     ========================================================= */
  function g(id) { return document.getElementById(id); }

  /* ---- Is the cursor inside the drop zone? ---- */
  function overDropZone(x, y) {
    var r = dropZone.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  /* =========================================================
     FINGER-CURL DETECTION
     Uses 3D Euclidean distance: tip-to-wrist vs mcp-to-wrist.
     Returns true if the finger is curled (tip closer to wrist than knuckle).
     Written out fully — NO missing operators, NO Math.pow.
     ========================================================= */
  function isCurled(lm, tipIdx, mcpIdx) {
    var w  = lm[0];
    var t  = lm[tipIdx];
    var m  = lm[mcpIdx];

    var tipDist = Math.sqrt(
      (t.x - w.x) * (t.x - w.x) +
      (t.y - w.y) * (t.y - w.y) +
      (t.z - w.z) * (t.z - w.z)
    );
    var mcpDist = Math.sqrt(
      (m.x - w.x) * (m.x - w.x) +
      (m.y - w.y) * (m.y - w.y) +
      (m.z - w.z) * (m.z - w.z)
    );

    return tipDist < mcpDist * 1.2;
  }

  /* =========================================================
     GESTURE CLASSIFICATION
     ========================================================= */
  function classifyGesture(lm) {
    var idx  = isCurled(lm,  8,  5);
    var mid  = isCurled(lm, 12,  9);
    var ring = isCurled(lm, 16, 13);
    var pin  = isCurled(lm, 20, 17);
    var n = (idx ? 1 : 0) + (mid ? 1 : 0) + (ring ? 1 : 0) + (pin ? 1 : 0);

    if (n >= 3) return "fist";
    if (n === 0) return "open";
    return "point";
  }

  /* =========================================================
     SMOOTHED CURSOR  (index fingertip, x mirrored)
     ========================================================= */
  function updateCursor(lm) {
    var tip = lm[8];
    var rx  = (1 - tip.x) * window.innerWidth;
    var ry  = tip.y * window.innerHeight;
    var f   = CFG.smoothing;
    gx = gx * f + rx * (1 - f);
    gy = gy * f + ry * (1 - f);
    return { x: gx, y: gy };
  }

  /* =========================================================
     Z-PUSH DETECTION
     A "push" is when the wrist moves toward the camera
     (wrist Z decreases by more than pushZThreshold in one frame).
     ========================================================= */
  function detectPush(lm) {
    var wz = lm[0].z;

    if (pushCooldown > 0) {
      pushCooldown--;
      lastWristZ = wz;
      return false;
    }
    if (lastWristZ === null) {
      lastWristZ = wz;
      return false;
    }

    var delta = lastWristZ - wz;   // positive = hand moved closer to camera
    lastWristZ = wz;

    if (delta > CFG.pushZThreshold) {
      pushCooldown = CFG.pushResetFrames;
      return true;
    }
    return false;
  }

  /* =========================================================
     DOUBLE-PUSH HANDLER
     First push  → show "👆 1" badge, wait for second
     Second push → if over drop zone open file picker, else fire click
     ========================================================= */
  function onPush(pos) {
    var now   = Date.now();
    var flash = g("gFlash");
    var badge = g("gBadge");

    // flash the preview overlay
    flash.style.opacity = "1";
    setTimeout(function () { flash.style.opacity = "0"; }, 140);

    var on_dz = overDropZone(pos.x, pos.y);

    if (pushCount === 0 || (now - firstPushAt) > CFG.doublePushMs) {
      /* ---- first push ---- */
      pushCount   = 1;
      firstPushAt = now;
      badge.textContent = "👆 1";
      badge.style.opacity = "1";
      if (on_dz) dropZone.classList.add("gesture-hover");
      clearTimeout(pushTimer);
      pushTimer = setTimeout(function () {
        pushCount   = 0;
        firstPushAt = null;
        badge.style.opacity = "0";
        dropZone.classList.remove("gesture-hover");
      }, CFG.doublePushMs);

    } else {
      /* ---- second push = double-push confirmed ---- */
      pushCount   = 0;
      firstPushAt = null;
      clearTimeout(pushTimer);
      dropZone.classList.remove("gesture-hover");

      badge.textContent   = "✅";
      badge.style.opacity = "1";
      setTimeout(function () { badge.style.opacity = "0"; }, 700);

      if (on_dz) {
        write("👆 Double-push — opening file picker", "info");
        // small delay so the badge animates before the dialog opens
        setTimeout(function () { fileInput.click(); }, 50);
      } else {
        fireClick(pos);
      }
    }
  }

  /* =========================================================
     FIRE A REAL CLICK AT (x, y)
     ========================================================= */
  function fireClick(pos) {
    var x = pos.x, y = pos.y;
    var rip = g("gRipple");

    rip.style.display    = "block";
    rip.style.left       = x + "px";
    rip.style.top        = y + "px";
    rip.style.opacity    = "1";
    rip.style.transition = "none";
    rip.style.transform  = "translate(-50%,-50%) scale(0)";

    requestAnimationFrame(function () {
      rip.style.transition = "transform .38s ease-out, opacity .38s ease-out";
      rip.style.transform  = "translate(-50%,-50%) scale(1)";
      rip.style.opacity    = "0";
    });
    setTimeout(function () { rip.style.display = "none"; }, 420);

    var target = document.elementFromPoint(x, y);
    if (target) {
      target.dispatchEvent(new MouseEvent("click", {
        bubbles: true, cancelable: true, clientX: x, clientY: y
      }));
      write("👆 Click → " + target.tagName.toLowerCase() +
            (target.id ? "#" + target.id : ""), "info");
    }
  }

  /* =========================================================
     PER-FRAME GESTURE LOGIC
     ========================================================= */
  function handleGesture(gesture, pos, lm) {
    var cursor = g("gCursor");
    var label  = g("gLabel");
    var debug  = g("gDebug");
    var on_dz  = overDropZone(pos.x, pos.y);

    // move cursor dot
    cursor.style.left = pos.x + "px";
    cursor.style.top  = pos.y + "px";
    debug.textContent = gesture.toUpperCase();

    // drop-zone hover glow (only before a file is staged)
    if (on_dz && !dropZone.classList.contains("file-ready")) {
      dropZone.classList.add("gesture-hover");
    } else if (!on_dz) {
      dropZone.classList.remove("gesture-hover");
    }

    // Z-push only sensible while hand is open/pointing
    if (gesture === "point") {
      if (detectPush(lm)) onPush(pos);
    } else {
      lastWristZ = lm[0].z;           // keep reference fresh
      if (gesture !== "fist") pushCount = 0;
    }

    /* ---- FIST = start grab ---- */
    if (gesture === "fist") {
      grabCount++; sendCount = 0;
      cursor.style.background = "rgba(255,77,109,.9)";
      cursor.style.boxShadow  = "0 0 18px rgba(255,77,109,.8)";
      cursor.style.transform  = "translate(-50%,-50%) scale(1.4)";

      if (grabCount >= CFG.grabFrames && !isGrabbing) {
        if (gestureState.filesReady) {
          isGrabbing = true;
          hasSent    = false;
          label.textContent = "✊ Grabbed! Open fist to send";
          write("✊ Grabbed — open fist to send!", "info");
        } else {
          label.textContent = "⚠️ Pick a file first";
        }
      }

    /* ---- OPEN (while grabbing) = send ---- */
    } else if (gesture === "open" && isGrabbing) {
      sendCount++; grabCount = 0;
      cursor.style.background = "rgba(74,222,128,.9)";
      cursor.style.boxShadow  = "0 0 18px rgba(74,222,128,.8)";
      cursor.style.transform  = "translate(-50%,-50%) scale(1.6)";

      if (sendCount >= CFG.sendFrames && !hasSent) {
        hasSent    = true;
        isGrabbing = false;
        label.textContent = "🚀 Sending!";
        gestureSendFiles();   // defined in index.html client block
        setTimeout(function () {
          cursor.style.transform = "translate(-50%,-50%) scale(1)";
          label.textContent = "👆 Point to aim";
        }, 1200);
      }

    /* ---- ANYTHING ELSE = idle / pointing ---- */
    } else {
      grabCount = 0; sendCount = 0;
      cursor.style.background = "rgba(120,220,255,.82)";
      cursor.style.boxShadow  = "0 0 14px rgba(120,220,255,.8)";
      cursor.style.transform  = "translate(-50%,-50%) scale(1)";

      if      (isGrabbing)              label.textContent = "✊ Holding — open to send";
      else if (gestureState.filesReady) label.textContent = "✊ Fist to grab & send";
      else if (on_dz)                   label.textContent = "👆👆 Double-push to pick file";
      else                              label.textContent = "👆 Point to aim";
    }
  }

  /* =========================================================
     DRAW SKELETON (black background, no video)
     ========================================================= */
  function drawSkeleton(canvas, lm, gesture) {
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    var color = gesture === "fist" ? "#ff4d6d"
              : gesture === "open" ? "#4ade80"
              :                      "#78dcff";

    var bones = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [0,9],[9,10],[10,11],[11,12],
      [0,13],[13,14],[14,15],[15,16],
      [0,17],[17,18],[18,19],[19,20],
      [5,9],[9,13],[13,17]
    ];

    ctx.strokeStyle = color;
    ctx.lineWidth   = 2.5;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 8;
    ctx.globalAlpha = 0.9;

    bones.forEach(function (b) {
      ctx.beginPath();
      ctx.moveTo(lm[b[0]].x * w, lm[b[0]].y * h);
      ctx.lineTo(lm[b[1]].x * w, lm[b[1]].y * h);
      ctx.stroke();
    });

    ctx.shadowBlur = 14;
    lm.forEach(function (p, i) {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, i === 8 ? 7 : 4, 0, Math.PI * 2);
      ctx.fillStyle   = i === 8 ? "#fff" : color;
      ctx.globalAlpha = 1;
      ctx.fill();
    });

    ctx.shadowBlur  = 0;
    ctx.globalAlpha = 1;
  }

  /* =========================================================
     BUILD GESTURE UI ELEMENTS
     Called once on DOMContentLoaded.
     ========================================================= */
  function buildUI() {
    /* ---- preview box (bottom-right) ---- */
    var box = document.createElement("div");
    box.id = "gBox";
    box.style.cssText =
      "position:fixed;bottom:20px;right:20px;" +
      "width:220px;height:165px;border-radius:12px;overflow:hidden;" +
      "border:2px solid rgba(120,220,255,.32);background:#000;" +
      "z-index:1000;box-shadow:0 4px 24px rgba(0,0,0,.6);";

    /* hidden video — feeds MediaPipe, never visible to user */
    var vid = document.createElement("video");
    vid.id = "gVideo";
    vid.autoplay = true; vid.playsInline = true; vid.muted = true;
    vid.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;";

    /* canvas — skeleton on black bg, mirrored to match real-world orientation */
    var cvs = document.createElement("canvas");
    cvs.id = "gCanvas";
    cvs.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;" +
      "transform:scaleX(-1);background:#000;";

    /* push flash overlay */
    var flash = document.createElement("div");
    flash.id = "gFlash";
    flash.style.cssText =
      "position:absolute;inset:0;background:rgba(120,220,255,.17);" +
      "border-radius:12px;opacity:0;pointer-events:none;transition:opacity .12s;";

    /* push counter badge — top-left */
    var badge = document.createElement("div");
    badge.id = "gBadge";
    badge.style.cssText =
      "position:absolute;top:5px;left:7px;font-size:11px;" +
      "color:#78dcff;font-family:sans-serif;opacity:0;transition:opacity .18s;";

    /* gesture name debug — top-right */
    var debug = document.createElement("div");
    debug.id = "gDebug";
    debug.style.cssText =
      "position:absolute;top:5px;right:6px;font-size:10px;" +
      "color:rgba(255,255,255,.32);font-family:sans-serif;";

    /* status label — bottom-center */
    var label = document.createElement("div");
    label.id = "gLabel";
    label.style.cssText =
      "position:absolute;bottom:5px;left:0;right:0;text-align:center;" +
      "font-size:11px;color:#78dcff;font-family:sans-serif;text-shadow:0 1px 3px #000;";
    label.textContent = "Click ✋ to start";

    [vid, cvs, flash, badge, debug, label].forEach(function (n) { box.appendChild(n); });
    document.body.appendChild(box);

    /* ---- toggle button (above preview) ---- */
    var btn = document.createElement("button");
    btn.id = "gToggle";
    btn.textContent = "✋ Gesture OFF";
    btn.style.cssText =
      "position:fixed;bottom:196px;right:20px;padding:8px 16px;" +
      "background:rgba(120,220,255,.1);border:1px solid rgba(120,220,255,.32);" +
      "border-radius:8px;color:#78dcff;font-size:13px;cursor:pointer;" +
      "z-index:1001;font-weight:600;";
    btn.addEventListener("click", toggleGesture);
    document.body.appendChild(btn);

    /* ---- cursor dot (full page) ---- */
    var cur = document.createElement("div");
    cur.id = "gCursor";
    cur.style.cssText =
      "position:fixed;width:26px;height:26px;border-radius:50%;" +
      "background:rgba(120,220,255,.85);border:2px solid #fff;" +
      "pointer-events:none;z-index:9999;" +
      "transform:translate(-50%,-50%);display:none;" +
      "box-shadow:0 0 14px rgba(120,220,255,.9);" +
      "transition:background .1s,box-shadow .1s,transform .12s;";
    document.body.appendChild(cur);

    /* ---- click ripple ---- */
    var rip = document.createElement("div");
    rip.id = "gRipple";
    rip.style.cssText =
      "position:fixed;width:66px;height:66px;border-radius:50%;" +
      "border:3px solid rgba(120,220,255,.85);" +
      "pointer-events:none;z-index:9998;" +
      "transform:translate(-50%,-50%) scale(0);display:none;opacity:0;";
    document.body.appendChild(rip);
  }

  /* =========================================================
     START MEDIAPIPE
     Key fix: await hands.initialize() BEFORE camera.start()
     so the WASM model is fully loaded before any frames arrive.
     ========================================================= */
  async function startGesture() {
    var vid    = g("gVideo");
    var canvas = g("gCanvas");
    var cursor = g("gCursor");
    var label  = g("gLabel");

    /* ---- 1. get camera stream ---- */
    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: 640, height: 480 }
      });
      vid.srcObject = stream;
      await new Promise(function (resolve) { vid.onloadedmetadata = resolve; });
      canvas.width  = vid.videoWidth  || 640;
      canvas.height = vid.videoHeight || 480;
    } catch (err) {
      label.textContent = "Camera error ❌";
      write("Camera: " + err.message, "error");
      return;
    }

    /* ---- 2. create MediaPipe Hands instance ---- */
    // locateFile MUST point to the SAME version as the <script> tag in index.html
    label.textContent = "Loading model...";
    var hands = new Hands({
      locateFile: function (f) {
        return "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/" + f;
      }
    });

    hands.setOptions({
      maxNumHands:            1,
      modelComplexity:        1,
      minDetectionConfidence: CFG.minDetection,
      minTrackingConfidence:  CFG.minTracking
    });

    /* ---- 3. register results callback ---- */
    hands.onResults(function (res) {
      if (!running) return;

      var ctx = canvas.getContext("2d");

      if (res.multiHandLandmarks && res.multiHandLandmarks.length > 0) {
        var lm      = res.multiHandLandmarks[0];
        var gesture = classifyGesture(lm);
        var pos     = updateCursor(lm);

        drawSkeleton(canvas, lm, gesture);
        cursor.style.display = "block";
        handleGesture(gesture, pos, lm);
      } else {
        // no hand detected — clear canvas and reset state
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        cursor.style.display = "none";
        g("gDebug").textContent = "";
        label.textContent = "🖐️ Show your hand";
        dropZone.classList.remove("gesture-hover");
        grabCount = 0; sendCount = 0;
        lastWristZ = null; isGrabbing = false;
      }
    });

    /* ---- 4. initialize WASM model FIRST (critical) ---- */
    await hands.initialize();

    /* ---- 5. now start feeding frames ---- */
    var camera = new Camera(vid, {
      onFrame: async function () {
        if (running) await hands.send({ image: vid });
      },
      width: 640, height: 480
    });

    camera.start();

    /* ---- 6. update UI ---- */
    running = true;
    label.textContent        = "👆 Point to aim";
    cursor.style.display     = "block";
    g("gToggle").textContent      = "✋ Gesture ON";
    g("gToggle").style.background = "rgba(120,220,255,.22)";
    write("Gesture control active ✔", "success");
  }

  /* =========================================================
     TOGGLE
     ========================================================= */
  function toggleGesture() {
    if (!running) {
      startGesture();
    } else {
      running = false;
      g("gCursor").style.display    = "none";
      g("gLabel").textContent       = "Gesture OFF";
      g("gToggle").textContent      = "✋ Gesture OFF";
      g("gToggle").style.background = "rgba(120,220,255,.1)";
      write("Gesture OFF", "info");
    }
  }

  /* =========================================================
     INIT — build UI on DOMContentLoaded.
     Do NOT auto-start; user must click the toggle button.
     ========================================================= */
  window.addEventListener("DOMContentLoaded", buildUI);

})(); // end IIFE