 # Airpop 
> Cross-platform file transfer controlled by hand gestures. No app. No Bluetooth. Just a browser link.

## Try it live
**[airpop.onrender.com](https://airpop.onrender.com)**

## The problem
Sending files between an Android and a Mac meant emailing them to myself. AirDrop is Apple-only. Google's Nearby Share is Android-only. Everything else requires an app install.

## The solution
Airpop works in the browser on any device. The interaction is simple:

- ✊ **Close fist** on Device 1 — grabs the file
- 🖐 **Open palm** on Device 2 — receives the file

No install. No pairing. No cables. Just open the same URL on two devices.

## How it works
1. Both devices connect via WebSocket signalling server
2. WebRTC establishes a peer-to-peer data channel
3. MediaPipe detects hand gestures in real time via device camera
4. Fist gesture on sender triggers `grab-gesture` socket event
5. Open palm on receiver triggers `ready-gesture` → file transfer begins
6. Files transfer directly device-to-device via WebRTC data channel

## Tech stack
| Layer | Technology |
|-------|-----------|
| Gesture detection | MediaPipe Hands |
| P2P transfer | WebRTC Data Channel |
| Signalling | Socket.io + WebSockets |
| Backend | Node.js + Express |
| Deployment | Render |

## Run locally
```bash
git clone https://github.com/birmarwah006-glitch/airpop.git
cd airpop
npm install
node server.js
```
Open `http://localhost:3000` on two devices on the same network.

## Built by
Bir Marwah — 18 years old, Nagpur, India 🇮🇳

Built in 48 hours. Got international users within hours of launch.

Twitter: [@BirMarwah456](https://twitter.com/BirMarwah456)