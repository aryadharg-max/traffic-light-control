// index.js
// Simple WebSocket Relay for NodeMCU <-> GitHub UI
// Usage: set env RELAY_TOKEN and optional PORT

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const RELAY_TOKEN = process.env.RELAY_TOKEN || 'changeme-token';

// HTTP app (optional health check)
const app = express();
app.get('/', (req, res) => res.send('WS Relay is running'));

// HTTP server
const server = http.createServer(app);

// WebSocket server
const wss = new WebSocket.Server({ server });

/*
Data structures:
- devices: { deviceId: ws }
- controllers: Set of ws (each controller can subscribe to a deviceId)
We store per-controller the deviceId(s) it wants to listen to in ws.subscriptions Set()
*/
const devices = new Map(); // deviceId => ws
const controllers = new Set();

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (e) { /* ignore */ }
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  // temporary state until auth
  ws.role = null;
  ws.deviceId = null;
  ws.subscriptions = new Set();

  // first message must be auth JSON: { type:'auth', role:'device'|'controller', token:'...', deviceId:'optional' }
  ws.once('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) {
      safeSend(ws, { type: 'error', message: 'invalid json' });
      ws.close();
      return;
    }

    if (msg.type !== 'auth' || msg.token !== RELAY_TOKEN || (msg.role !== 'device' && msg.role !== 'controller')) {
      safeSend(ws, { type: 'error', message: 'auth failed' });
      ws.close();
      return;
    }

    ws.role = msg.role;

    if (ws.role === 'device') {
      if (!msg.deviceId || typeof msg.deviceId !== 'string') {
        safeSend(ws, { type: 'error', message: 'deviceId required' });
        ws.close();
        return;
      }
      ws.deviceId = msg.deviceId;
      // if a previous connection existed, close it
      const prev = devices.get(ws.deviceId);
      if (prev && prev !== ws) {
        try { prev.close(); } catch(e) {}
      }
      devices.set(ws.deviceId, ws);
      safeSend(ws, { type: 'auth', result: 'ok', role: 'device', deviceId: ws.deviceId });
      console.log(`Device connected: ${ws.deviceId}`);
    } else {
      // controller
      controllers.add(ws);
      safeSend(ws, { type: 'auth', result: 'ok', role: 'controller' });
      console.log('Controller connected');
    }

    // now set general message handler
    ws.on('message', (dataRaw) => {
      let data;
      try { data = JSON.parse(dataRaw.toString()); } catch (e) {
        safeSend(ws, { type: 'error', message: 'invalid json' });
        return;
      }

      // Device => telemetry (forward to controllers subscribed to this device)
      if (ws.role === 'device') {
        // expect { type: 'telemetry', payload: { ... } }
        if (data.type === 'telemetry') {
          // forward to all controllers that have subscription to this device (or broadcast to all controllers)
          controllers.forEach(ctrl => {
            // if controller has no subscriptions, assume they want all devices
            if (ctrl.subscriptions.size === 0 || ctrl.subscriptions.has(ws.deviceId)) {
              safeSend(ctrl, { type: 'telemetry', deviceId: ws.deviceId, payload: data.payload });
            }
          });
        }
        // device can also accept direct responses, logs etc.
      }

      // Controller => commands (forward to device)
      else if (ws.role === 'controller') {
        // expect { type:'command', deviceId:'device-1', payload: {...} }
        if (data.type === 'subscribe') {
          // subscribe to device updates: { type:'subscribe', deviceId:'device-1' }
          if (data.deviceId && typeof data.deviceId === 'string') {
            ws.subscriptions.add(data.deviceId);
            safeSend(ws, { type: 'subscribed', deviceId: data.deviceId });
          }
          return;
        } else if (data.type === 'unsubscribe') {
          if (data.deviceId) { ws.subscriptions.delete(data.deviceId); safeSend(ws,{type:'unsubscribed', deviceId: data.deviceId}); }
          return;
        } else if (data.type === 'command') {
          const target = data.deviceId;
          const payload = data.payload;
          if (!target || !payload) {
            safeSend(ws, { type: 'error', message: 'command must include deviceId and payload' });
            return;
          }
          const targetWs = devices.get(target);
          if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
            safeSend(ws, { type: 'error', message: 'device not connected', deviceId: target });
            return;
          }
          // forward command: { type:'command', payload: {...} } to device
          safeSend(targetWs, { type: 'command', payload });
          safeSend(ws, { type: 'ok', message: 'command forwarded' });
          return;
        }
      }
    });

    // cleanup on close
    ws.on('close', () => {
      if (ws.role === 'device') {
        console.log(`Device disconnected: ${ws.deviceId}`);
        if (ws.deviceId && devices.get(ws.deviceId) === ws) devices.delete(ws.deviceId);
      } else if (ws.role === 'controller') {
        controllers.delete(ws);
        console.log('Controller disconnected');
      }
    });
  }); // end once auth
});

// ping/pong for keepalive and cleanup dead clients
const interval = setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch(e) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(() => {}); } catch(e) {}
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`WS Relay running on port ${PORT}`);
  if (!process.env.RELAY_TOKEN) {
    console.warn('WARNING: RELAY_TOKEN not set. Using default token (insecure). Set RELAY_TOKEN env var in deployment.');
  }
});
