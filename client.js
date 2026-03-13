 // client.js — AirPop Live

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

const CHUNK_SIZE = 64 * 1024; // 64KB

let socket;
let pc = null;
let dataChannel = null;
let peerId = null;
let receiveBuffer = { chunks: [], meta: null, received: 0 };

// ========== UI Elements ==========
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const connectBtn = document.getElementById("connectBtn");
const cancelBtn = document.getElementById("cancelBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const sendCard = document.getElementById("sendCard");
const receiveCard = document.getElementById("receiveCard");
const receivedArea = document.getElementById("receivedArea");
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const sendProgressWrap = document.getElementById("sendProgressWrap");
const sendProgressBar = document.getElementById("sendProgressBar");
const sendProgressLabel = document.getElementById("sendProgressLabel");
const logEl = document.getElementById("log");
const peerStatus = document.getElementById("peerStatus");

// ========== Logging ==========
function write(msg, type = "") {
  const div = document.createElement("div");
  div.className = "entry " + type;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// ========== UI State ==========
function setServerStatus(connected) {
  statusDot.className = "status-dot " + (connected ? "connected" : "disconnected");
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

// ========== Socket ==========
function initSocket() {
  socket = io(window.location.origin);

  socket.on("connect", () => {
    setServerStatus(true);
    setState("idle");
    write("Connected to server", "success");
  });

  socket.on("disconnect", () => {
    setServerStatus(false);
    write("Disconnected from server", "error");
  });

  socket.on("connect_error", err => write("Connection error: " + err.message, "error"));

  socket.on("waiting", () => {
    setState("searching");
    write("Waiting for a peer...", "info");
  });

  socket.on("search-cancelled", () => {
    setState("idle");
    write("Search cancelled", "info");
  });

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
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    }
  });

  socket.on("peer-left", () => {
    write("Peer disconnected", "error");
    closePeer();
    setState("idle");
  });
}

// ========== WebRTC ==========
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
  peerId = null;
}

// ========== Data Channel ==========
function setupDataChannel(dc) {
  dc.binaryType = "arraybuffer";

  dc.onopen = () => write("Direct P2P file channel open ✔", "success");
  dc.onclose = () => write("File channel closed");

  dc.onmessage = ({ data }) => {
    if (typeof data === "string") {
      const msg = JSON.parse(data);
      if (msg.type === "file-start") {
        receiveBuffer = { chunks: [], meta: msg, received: 0 };
        write(`Receiving: ${msg.name} (${formatSize(msg.size)})`, "info");
        receiveCard.classList.remove("hidden");
      } else if (msg.type === "file-end") {
        finalizeFile();
      }
    } else {
      receiveBuffer.chunks.push(data);
      receiveBuffer.received += data.byteLength;
    }
  };
}

function finalizeFile() {
  const { chunks, meta } = receiveBuffer;
  const blob = new Blob(chunks, { type: meta.fileType });
  const url = URL.createObjectURL(blob);

  if (meta.fileType.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = url;
    img.title = meta.name;
    receivedArea.appendChild(img);
  } else if (meta.fileType.startsWith("video/")) {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    receivedArea.appendChild(video);
  } else {
    const item = document.createElement("div");
    item.className = "file-item";
    item.innerHTML = `📄 <a href="${url}" download="${meta.name}">${meta.name}</a> (${formatSize(meta.size)})`;
    receivedArea.appendChild(item);
  }

  write(`Received: ${meta.name} ✔`, "success");
  receiveBuffer = { chunks: [], meta: null, received: 0 };
}

// ========== Send File ==========
function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

async function sendFile(file) {
  if (!dataChannel || dataChannel.readyState !== "open") {
    write("No peer connected yet.", "error");
    return;
  }

  const buffer = await file.arrayBuffer();
  const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);

  sendProgressWrap.style.display = "block";

  dataChannel.send(JSON.stringify({
    type: "file-start",
    name: file.name,
    size: buffer.byteLength,
    fileType: file.type || "application/octet-stream"
  }));

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const chunk = buffer.slice(start, start + CHUNK_SIZE);

    while (dataChannel.bufferedAmount > 1024 * 1024) {
      await new Promise(r => setTimeout(r, 50));
    }

    dataChannel.send(chunk);

    const pct = Math.round(((i + 1) / totalChunks) * 100);
    sendProgressBar.style.width = pct + "%";
    sendProgressLabel.textContent = `${file.name} — ${pct}% (${formatSize(start + chunk.byteLength)} / ${formatSize(buffer.byteLength)})`;
  }

  dataChannel.send(JSON.stringify({ type: "file-end" }));
  write(`Sent: ${file.name} ✔`, "success");

  setTimeout(() => {
    sendProgressWrap.style.display = "none";
    sendProgressBar.style.width = "0%";
    sendProgressLabel.textContent = "";
  }, 2000);
}

// ========== Button Events ==========
connectBtn.addEventListener("click", () => {
  socket.emit("find-peer");
  setState("searching");
  write("Searching for a peer...", "info");
});

cancelBtn.addEventListener("click", () => {
  socket.emit("cancel-search");
});

disconnectBtn.addEventListener("click", () => {
  closePeer();
  setState("idle");
  write("Disconnected from peer", "info");
});

// ========== Drop Zone ==========
dropZone.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover", e => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));

dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  [...e.dataTransfer.files].forEach(sendFile);
});

fileInput.addEventListener("change", () => {
  [...fileInput.files].forEach(sendFile);
  fileInput.value = "";
});

// ========== Init ==========
initSocket();