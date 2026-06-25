// client.js — AirPop Live (Streaming Rewrite with Multi-File & Folder Queue Support)

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ]
};

// ── Chunk & backpressure tuning ───────────────────────────────
const CHUNK_SIZE  = 64 * 1024; // 64KB slices for smooth data streaming
const BUFFER_HIGH = 1 * 1024 * 1024; // Pause streaming at 1MB buffered
const BUFFER_LOW  = 128 * 1024; // Resume streaming at 128KB remaining

let socket;
let pc          = null;
let dataChannel = null;
let peerId      = null;

// Receive state — track incoming streaming bytes
let receiveBuffer = { chunks: [], meta: null, received: 0 };

// ── UI Elements ───────────────────────────────────────────────
const statusDot        = document.getElementById("statusDot");
const statusText       = document.getElementById("statusText");
const connectBtn       = document.getElementById("connectBtn");
const cancelBtn        = document.getElementById("cancelBtn");
const disconnectBtn    = document.getElementById("disconnectBtn");
const sendCard         = document.getElementById("sendCard");
const receiveCard      = document.getElementById("receiveCard");
const receivedArea     = document.getElementById("receivedArea");
const dropZone         = document.getElementById("dropZone");
const fileInput        = document.getElementById("fileInput");
const sendProgressWrap = document.getElementById("sendProgressWrap");
const sendProgressBar  = document.getElementById("sendProgressBar");
const sendProgressLabel= document.getElementById("sendProgressLabel");
const logEl            = document.getElementById("log");
const peerStatus       = document.getElementById("peerStatus");

// Receiver progress elements
let recvProgressWrap  = document.getElementById("recvProgressWrap");
let recvProgressBar   = document.getElementById("recvProgressBar");
let recvProgressLabel = document.getElementById("recvProgressLabel");

if (!recvProgressWrap) {
  recvProgressWrap = document.createElement("div");
  recvProgressWrap.id = "recvProgressWrap";
  recvProgressWrap.style.cssText = "display:none; margin-top:8px;";

  recvProgressBar = document.createElement("div");
  recvProgressBar.id = "recvProgressBar";
  recvProgressBar.style.cssText =
    "height:6px; background:#4ade80; width:0%; border-radius:3px; transition:width .1s;";

  recvProgressLabel = document.createElement("div");
  recvProgressLabel.id = "recvProgressLabel";
  recvProgressLabel.style.cssText = "font-size:12px; margin-top:4px; color:#aaa;";

  recvProgressWrap.appendChild(recvProgressBar);
  recvProgressWrap.appendChild(recvProgressLabel);

  const anchor = receiveCard || sendCard;
  if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(recvProgressWrap, anchor.nextSibling);
  } else {
    document.body.appendChild(recvProgressWrap);
  }
}

// ── Logging ───────────────────────────────────────────────────
function write(msg, type = "") {
  const div = document.createElement("div");
  div.className = "entry " + type;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// ── UI State ──────────────────────────────────────────────────
function setServerStatus(connected) {
  statusDot.className  = "status-dot " + (connected ? "connected" : "disconnected");
  statusText.textContent = connected ? "Connected to server ✔" : "Disconnected ❌";
}

function setState(state) {
  connectBtn.classList.add("hidden");
  cancelBtn.classList.add("hidden");
  disconnectBtn.classList.add("hidden");
  sendCard.classList.add("hidden");
  peerStatus.textContent = "";
  peerStatus.classList.remove("searching");

  if (state === "idle") {
    connectBtn.classList.remove("hidden");
    connectBtn.disabled = false;
  } else if (state === "searching") {
    cancelBtn.classList.remove("hidden");
    peerStatus.textContent = "🔍 Searching for someone to connect with...";
    peerStatus.classList.add("searching");
  } else if (state === "connected") {
    disconnectBtn.classList.remove("hidden");
    sendCard.classList.remove("hidden");
    peerStatus.textContent = "✅ Peer connected — send files below!";
  }
}

// ── Socket ────────────────────────────────────────────────────
function initSocket() {
  socket = io(window.location.origin);

  socket.on("connect",       () => { setServerStatus(true);  setState("idle"); write("Connected to server", "success"); });
  socket.on("disconnect",    () => { setServerStatus(false); write("Disconnected from server", "error"); });
  socket.on("connect_error", err => write("Connection error: " + err.message, "error"));

  socket.on("waiting",         () => { setState("searching"); write("Waiting for a peer...", "info"); });
  socket.on("search-cancelled",() => { setState("idle");      write("Search cancelled", "info"); });

  socket.on("matched", ({ roomId, initiator, peerId: pid }) => {
    peerId = pid;
    write("Matched! Setting up P2P connection...", "info");
    setupPeerConnection(initiator);
  });

  socket.on("offer", async ({ from, offer }) => {
    if (!pc) setupPeerConnection(false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("answer", { to: from, answer });
  });

  socket.on("answer", async ({ from, answer }) => {
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on("ice-candidate", async ({ from, candidate }) => {
    if (pc) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
    }
  });

  socket.on("peer-left", () => {
    write("Peer disconnected", "error");
    closePeer();
    setState("idle");
  });
}

// ── WebRTC ────────────────────────────────────────────────────
function setupPeerConnection(initiator) {
  pc = new RTCPeerConnection(ICE_SERVERS);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit("ice-candidate", { to: peerId, candidate });
  };

  pc.onconnectionstatechange = () => {
    write(`P2P: ${pc.connectionState}`, pc.connectionState === "connected" ? "success" : "");
    if (pc.connectionState === "connected") setState("connected");
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      write("P2P connection lost", "error");
      closePeer();
      setState("idle");
    }
  };

  if (initiator) {
    dataChannel = pc.createDataChannel("airpop", { ordered: true });
    setupDataChannel(dataChannel);
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      socket.emit("offer", { to: peerId, offer });
    });
  } else {
    pc.ondatachannel = ({ channel }) => {
      dataChannel = channel;
      setupDataChannel(dataChannel);
    };
  }
}

function closePeer() {
  if (pc) { pc.close(); pc = null; }
  dataChannel = null;
  peerId      = null;
}

// ── Data Channel ──────────────────────────────────────────────
function setupDataChannel(dc) {
  dc.binaryType = "arraybuffer";

  dc.onopen  = () => write("Direct P2P file channel open ✔", "success");
  dc.onclose = () => write("File channel closed");

  dc.onmessage = ({ data }) => {
    if (typeof data === "string") {
      const msg = JSON.parse(data);

      if (msg.type === "file-start") {
        receiveBuffer = { chunks: [], meta: msg, received: 0 };
        recvProgressWrap.style.display = "block";
        recvProgressBar.style.width    = "0%";
        
        const displayName = msg.relativePath || msg.name;
        recvProgressLabel.textContent  = `Receiving ${displayName} (${formatSize(msg.size)})…`;
        write(`Receiving: ${displayName} (${formatSize(msg.size)})`, "info");
        receiveCard.classList.remove("hidden");

      } else if (msg.type === "file-end") {
        finalizeFile();
      }

    } else {
      receiveBuffer.chunks.push(data);
      receiveBuffer.received += data.byteLength;

      if (receiveBuffer.meta) {
        const displayName = receiveBuffer.meta.relativePath || receiveBuffer.meta.name;
        const pct = Math.min(
          100,
          Math.round((receiveBuffer.received / receiveBuffer.meta.size) * 100)
        );
        recvProgressBar.style.width   = pct + "%";
        recvProgressLabel.textContent =
          `${displayName} — ${pct}% `+
          `(${formatSize(receiveBuffer.received)} / ${formatSize(receiveBuffer.meta.size)})`;
      }
    }
  };
}

function finalizeFile() {
  const { chunks, meta } = receiveBuffer;
  const blob = new Blob(chunks, { type: meta.fileType });
  const url  = URL.createObjectURL(blob);
  
  // Uses directory structure relative paths if uploading entire folders
  const displayName = meta.relativePath || meta.name;

  if (meta.fileType.startsWith("image/")) {
    const item = document.createElement("div");
    item.className = "file-item visual-media-item";
    item.style.margin = "8px 0";
    item.innerHTML = `
      🖼️ <a href="${url}" download="${displayName}">${displayName}</a> (${formatSize(meta.size)})
      <br><img src="${url}" title="${displayName}" style="max-width: 100%; max-height: 200px; border-radius: 6px; margin-top: 6px; display: block;">
    `;
    receivedArea.appendChild(item);
  } else if (meta.fileType.startsWith("video/")) {
    const item = document.createElement("div");
    item.className = "file-item visual-media-item";
    item.style.margin = "8px 0";
    item.innerHTML = `
      🎬 <a href="${url}" download="${displayName}">${displayName}</a> (${formatSize(meta.size)})
      <br><video src="${url}" controls style="max-width: 100%; max-height: 250px; border-radius: 6px; margin-top: 6px; display: block;"></video>
    `;
    receivedArea.appendChild(item);
  } else {
    const item = document.createElement("div");
    item.className = "file-item";
    item.innerHTML =
      `📄 <a href="${url}" download="${displayName}">${displayName}</a> (${formatSize(meta.size)})`;
    receivedArea.appendChild(item);
  }

  write(`Received: ${displayName} ✔`, "success");

  setTimeout(() => {
    recvProgressWrap.style.display = "none";
    recvProgressBar.style.width    = "0%";
    recvProgressLabel.textContent  = "";
  }, 1000);

  receiveBuffer = { chunks: [], meta: null, received: 0 };
}

// ── Helpers ───────────────────────────────────────────────────
function formatSize(bytes) {
  if (bytes < 1024)           return bytes + " B";
  if (bytes < 1024 * 1024)    return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function waitForDrain(dc) {
  return new Promise(resolve => {
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    dc.onbufferedamountlow = () => {
      dc.onbufferedamountlow = null;
      resolve();
    };
  });
}

// ── Send File Core (Returns a Promise for Queue Synchronization) ──
function sendFile(file) {
  return new Promise(async (resolve) => {
    if (!dataChannel || dataChannel.readyState !== "open") {
      write("No peer connected yet.", "error");
      return resolve();
    }

    const fileType    = file.type || "application/octet-stream";
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const displayName = file.webkitRelativePath || file.name;

    sendProgressWrap.style.display = "block";
    sendProgressBar.style.width    = "0%";
    sendProgressLabel.textContent  = `${displayName} — preparing…`;
  
    

    // Send metadata out with path information attached
    dataChannel.send(JSON.stringify({
      type: "file-start",
      name: file.name,
      size: file.size,
      fileType,
      relativePath: file.webkitRelativePath || file.name
    }));

    write(`Sending: ${displayName} (${formatSize(file.size)})`, "info");

    for (let i = 0; i < totalChunks; i++) {
      const start  = i * CHUNK_SIZE;
      const end    = Math.min(start + CHUNK_SIZE, file.size);
      const chunk  = await file.slice(start, end).arrayBuffer();

      if (dataChannel.bufferedAmount > BUFFER_HIGH) {
        await waitForDrain(dataChannel);
      }

      dataChannel.send(chunk);

      const pct = Math.round(((i + 1) / totalChunks) * 100);
      sendProgressBar.style.width    = pct + "%";
      sendProgressLabel.textContent  =
        `${displayName} — ${pct}% (${formatSize(end)} / ${formatSize(file.size)})`;
    }

    dataChannel.send(JSON.stringify({ type: "file-end" }));
    write(`Sent: ${displayName} ✔`, "success");

    setTimeout(() => {
      sendProgressWrap.style.display = "none";
      sendProgressBar.style.width    = "0%";
      sendProgressLabel.textContent  = "";
    }, 1000);

    // Short cool down interval between separate items inside data stream
    setTimeout(resolve, 400);
  });
}

// ── Gesture Bridge (Now Processes Queued Items Synchronously) ──
const gestureState = { filesReady: false };

async function gestureSendFiles() {
  const files = fileInput.files;
  if (files && files.length > 0) {
    write(`Processing bulk transfer of ${files.length} items...`, "info");
    for (const file of files) {
      await sendFile(file);
    }
    fileInput.value           = "";
    gestureState.filesReady   = false;
    dropZone.classList.remove("file-ready");
  }
}

// ── Button Events ─────────────────────────────────────────────
connectBtn.addEventListener("click", () => {
  socket.emit("find-peer");
  setState("searching");
  write("Searching for a peer...", "info");
});

cancelBtn.addEventListener("click", () => socket.emit("cancel-search"));

disconnectBtn.addEventListener("click", () => {
  closePeer();
  setState("idle");
  write("Disconnected from peer", "info");
});

// ── Drop Zone (Now Processes Drag-and-Drop Bulk Queues) ─────────
dropZone.addEventListener("dragover",  e => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop",      async e => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  
  const files = [...e.dataTransfer.files];
  if (files.length > 0) {
    write(`Processing drop upload queue containing ${files.length} items...`, "info");
    for (const file of files) {
      await sendFile(file);
    }
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    gestureState.filesReady = true;
    dropZone.classList.add("file-ready");
    write(`${fileInput.files.length} item(s) staged — use gesture or trigger upload sequence`, "info");
  }
});

// ── Init ──────────────────────────────────────────────────────
initSocket();