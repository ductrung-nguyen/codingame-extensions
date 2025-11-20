// scripts/mock-bridge.js
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 45123 });

wss.on('connection', (socket) => {
  console.log('Extension connected');
  socket.on('message', (data) => {
    const msg = JSON.parse(data);
    console.log('Received', msg);
    if (msg.type === 'hello') {
      socket.send(JSON.stringify({ type: 'log', payload: 'Hello acknowledged' }));
    }
  });

  const interval = setInterval(() => {
    socket.send(JSON.stringify({ type: 'heartbeat' }));
  }, 9000);

  socket.on('close', () => clearInterval(interval));
});
