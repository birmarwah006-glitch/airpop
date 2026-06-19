/* =========================================================
   AIRPOPLIVE — GESTURE ENGINE
   Clean Aurora Build
========================================================= */

/* =========================================================
   1. CONFIG
========================================================= */

const CONFIG = {
  detectionConfidence: 0.7,
  trackingConfidence: 0.5,
  smoothing: 0.4,

  grabFramesRequired: 5,
  receiveFramesRequired: 3,

  camera: {
    width: 640,
    height: 480,
    facingMode: "user"
  }
};


/* =========================================================
   2. GLOBAL STATE
========================================================= */

const state = {
  running: false,

  handVisible: false,

  cursor: {
    x: 0,
    y: 0
  },

  gesture: {
    grabFrames: 0,
    receiveFrames: 0,

    grabbing: false,
    sent: false
  },

  particles: []
};


/* =========================================================
   3. DOM REFERENCES
========================================================= */

const ui = {
  video: null,
  canvas: null,
  label: null,
  button: null,
  gestureCanvas: null
};


/* =========================================================
   4. UTILITIES
========================================================= */

function smooth(current, target, factor) {
  return current * factor + target * (1 - factor);
}

function resetGestureState() {
  state.gesture.grabFrames = 0;
  state.gesture.receiveFrames = 0;
}


/* =========================================================
   5. PARTICLE ENGINE
========================================================= */

function createParticle(x, y, type) {

  const colorMap = {
    fist: "#e07a3a",
    open: "#52b788",
    point: "#2d6a4f"
  };

  state.particles.push({
    x,
    y,
    life: 1,
    size: Math.random() * 25 + 10,

    vx: (Math.random() - 0.5) * 8,
    vy: (Math.random() - 0.5) * 8,

    color: colorMap[type]
  });
}


function updateParticles(ctx) {

  for (let i = state.particles.length - 1; i >= 0; i--) {

    const p = state.particles[i];

    p.x += p.vx;
    p.y += p.vy;

    p.vx *= 0.96;
    p.vy *= 0.96;

    p.life -= 0.02;

    if (p.life <= 0) {
      state.particles.splice(i, 1);
      continue;
    }

    ctx.beginPath();

    ctx.arc(
      p.x,
      p.y,
      p.size * p.life,
      0,
      Math.PI * 2
    );

    ctx.globalAlpha = p.life * 0.5;
    ctx.fillStyle = p.color;
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}


/* =========================================================
   6. GESTURE CLASSIFIER
========================================================= */

function classifyGesture(landmarks) {

  const tips = [8, 12, 16, 20];
  const mcps = [5, 9, 13, 17];

  let curled = 0;

  for (let i = 0; i < 4; i++) {

    const wrist = landmarks[0];
    const tip = landmarks[tips[i]];
    const mcp = landmarks[mcps[i]];

    const tipDistance = Math.hypot(
      tip.x - wrist.x,
      tip.y - wrist.y
    );

    const mcpDistance = Math.hypot(
      mcp.x - wrist.x,
      mcp.y - wrist.y
    );

    if (tipDistance < mcpDistance * 1.2) {
      curled++;
    }
  }

  if (curled >= 3) return "fist";
  if (curled === 0) return "open";

  return "point";
}


/* =========================================================
   7. GESTURE ACTIONS
========================================================= */

function processGesture(type, position) {

  createParticle(position.x, position.y, type);

  switch (type) {

    case "fist":
      handleGrabGesture();
      break;

    case "open":
      handleReceiveGesture();
      break;

    default:
      resetGestureState();
      updateLabel("👆 Point to aim");
  }
}


function handleGrabGesture() {

  state.gesture.grabFrames++;
  state.gesture.receiveFrames = 0;

  if (
    state.gesture.grabFrames >= CONFIG.grabFramesRequired &&
    !state.gesture.grabbing
  ) {

    state.gesture.grabbing = true;

    updateLabel("✊ Grabbed!");
  }
}


function handleReceiveGesture() {

  state.gesture.receiveFrames++;
  state.gesture.grabFrames = 0;

  if (
    state.gesture.receiveFrames >= CONFIG.receiveFramesRequired &&
    !state.gesture.sent
  ) {

    state.gesture.sent = true;

    updateLabel("🖐 Ready to receive!");
  }
}


/* =========================================================
   8. MEDIAPIPE RESULTS
========================================================= */

function onHandResults(results) {

  const ctx = ui.gestureCanvas.getContext("2d");

  ctx.clearRect(
    0,
    0,
    ui.gestureCanvas.width,
    ui.gestureCanvas.height
  );

  if (!results.multiHandLandmarks?.length) {

    state.handVisible = false;

    resetGestureState();

    updateLabel("🖐 Show your hand");

    return;
  }

  state.handVisible = true;

  const landmarks = results.multiHandLandmarks[0];

  const gesture = classifyGesture(landmarks);

  const targetX =
    (1 - landmarks[8].x) * window.innerWidth;

  const targetY =
    landmarks[8].y * window.innerHeight;

  state.cursor.x = smooth(
    state.cursor.x,
    targetX,
    CONFIG.smoothing
  );

  state.cursor.y = smooth(
    state.cursor.y,
    targetY,
    CONFIG.smoothing
  );

  processGesture(
    gesture,
    state.cursor
  );
}


/* =========================================================
   9. UI HELPERS
========================================================= */

function updateLabel(text) {
  ui.label.textContent = text;
}


/* =========================================================
   10. START / STOP CAMERA
========================================================= */

async function startGestureSystem() {

  if (state.running) return;

  try {

    const stream =
      await navigator.mediaDevices.getUserMedia({
        video: CONFIG.camera
      });

    ui.video.srcObject = stream;

    await new Promise(resolve => {
      ui.video.onloadedmetadata = resolve;
    });

    state.running = true;

    updateLabel("👆 Point to aim");

    ui.button.textContent = "✋ Gesture ON";

  } catch (err) {

    console.error(err);

    updateLabel("Camera access denied");
  }
}


function stopGestureSystem() {

  if (!state.running) return;

  const tracks =
    ui.video.srcObject?.getTracks() || [];

  tracks.forEach(track => track.stop());

  ui.video.srcObject = null;

  state.running = false;

  updateLabel("Gesture OFF");

  ui.button.textContent = "✋ Gesture OFF";
}


/* =========================================================
   11. UI CREATION
========================================================= */

/* =========================================================
   11. UI CREATION (Rewritten for Humane Font)
========================================================= */

function buildUI() {
  // 1. Inject the font into the head
  if (!document.getElementById('airpop-font')) {
    const link = document.createElement('link');
    link.id = 'airpop-font';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap';
    document.head.appendChild(link);
  }

  ui.video = document.createElement("video");
  ui.video.autoplay = true;
  ui.video.playsInline = true;
  ui.video.muted = true;
  ui.video.style.cssText = "position:fixed; top:0; left:0; width:1px; height:1px; opacity:0; pointer-events:none;";

  ui.gestureCanvas = document.createElement("canvas");
  ui.gestureCanvas.style.cssText = "position:fixed; inset:0; pointer-events:none; z-index:9998;";

  // --- THE HUMANE STYLE LABEL ---
  ui.label = document.createElement("div");
  ui.label.style.cssText = `
    position: fixed;
    bottom: 40px;
    left: 0;
    right: 0;
    text-align: center;
    z-index: 9999;
    pointer-events: none;
    
    /* Font Styling to match Screenshot 2026-05-14 at 11.50.35 AM.jpg */
    font-family: 'Bebas Neue', sans-serif;
    font-size: 64px;
    font-weight: 400;
    color: #1a1916;
    text-transform: uppercase;
    letter-spacing: -1px;
    line-height: 1;
    
    /* The "Humane" Stretch */
    transform: scaleY(1.7);
    transform-origin: bottom;
    filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));
  `;

  // --- THE TOGGLE BUTTON ---
  ui.button = document.createElement("button");
  ui.button.textContent = "✋ GESTURE OFF";
  ui.button.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 9999;
    padding: 10px 20px;
    background: #1a1916;
    color: #ffffff;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    
    font-family: 'Bebas Neue', sans-serif;
    font-size: 20px;
    text-transform: uppercase;
    transform: scaleY(1.3);
    letter-spacing: 1px;
  `;

  ui.button.addEventListener("click", () => {
    state.running ? stopGestureSystem() : startGestureSystem();
  });

  document.body.appendChild(ui.video);
  document.body.appendChild(ui.gestureCanvas);
  document.body.appendChild(ui.label);
  document.body.appendChild(ui.button);
}

/* =========================================================
   12. INIT
========================================================= */

window.addEventListener(
  "DOMContentLoaded",
  buildUI
);