import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_ROOT = path.join(ROOT, 'web');
const STATIC_PORT = 7777;
const REALTIME_PORT = 7778;
const BRIDGE_PORT = 7780;
const HOST = '127.0.0.1';
const clients = new Set();
const owners = new Map();
let commands = [];
let protocolEvents = [];
let connectionCount = 0;
let subscriptionCount = 0;
let revision = 1;

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.py', 'text/x-python; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
]);

function jsonResponse(response, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

function fixtureState() {
  return {
    device: {name: 'Ingenue browser fixture', online: true},
    control: {keys: [0, 0, 0], encoders: [0, 0, 0]},
    script: {active: true, name: 'browser-contract-fixture'},
    grid: {
      ports: {
        '1': {
          port: 1,
          cols: 8,
          rows: 8,
          frame: '0'.repeat(64),
          sequence: revision,
          intensity: 15,
          rotation: 0,
          virtual: true,
        },
      },
    },
    arc: {
      ports: {
        '1': {
          port: 1,
          rings: 4,
          frame: '0'.repeat(256),
          sequence: revision,
          intensity: 15,
          virtual: true,
        },
      },
    },
    params: {
      generation: 'browser-contract-1',
      script: 'browser-contract-fixture',
      items: [
        {
          index: 1,
          id: 'cutoff',
          type: 3,
          name: 'Cutoff',
          kind: 'control',
          normalized: 0.5,
          value_text: '0.5',
          min_text: '0',
          max_text: '1',
          formatted: '0.50',
          behavior: 'continuous',
          writable: true,
          options: [],
        },
      ],
    },
    ownership: {
      resources: Object.fromEntries([...owners].map(([resource, clientId]) => [resource, {client_id: clientId}])),
    },
  };
}

function websocketFrame(payload, opcode = 1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  if (body.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

function send(client, message) {
  if (!client.socket.destroyed) client.socket.write(websocketFrame(JSON.stringify(message)));
}

function broadcast(message) {
  for (const client of clients) send(client, message);
}

function publishOwnership(resource, clientId) {
  revision += 1;
  const operation = clientId
    ? {op: 'set', path: ['ownership', 'resources', resource], value: {client_id: clientId}}
    : {op: 'delete', path: ['ownership', 'resources', resource]};
  broadcast({v: 1, type: 'delta', rev: revision, operations: [operation]});
}

function resourceFor(command) {
  if (!command || typeof command !== 'object') return null;
  if (command.target === 'control') return 'control';
  if (command.target === 'grid') return `grid:${Number(command.args?.port || 1)}`;
  if (command.target === 'arc') return `arc:${Number(command.args?.port || 1)}`;
  if (command.target === 'gamepad') return 'gamepad';
  if (command.target === 'param') return 'params';
  return null;
}

function paramDescriptor(id = 'cutoff', normalized = 0.5) {
  return {
    id,
    type: 3,
    name: id,
    kind: 'control',
    normalized,
    value_text: String(normalized),
    min_text: '0',
    max_text: '1',
    formatted: normalized.toFixed(2),
    behavior: 'continuous',
    writable: true,
    options: [],
  };
}

function reject(client, id, error) {
  send(client, {v: 1, type: 'reject', id, rev: revision, error});
}

function acknowledge(client, message) {
  const command = message.command || {};
  const id = message.id;
  if (command.target === 'session') {
    const action = command.action;
    if (action === 'claim') {
      const resource = String(command.args?.resource || '');
      const existing = owners.get(resource);
      if (existing && existing !== client.clientId) return reject(client, id, `resource ${resource} is owned by another client`);
      owners.set(resource, client.clientId);
      publishOwnership(resource, client.clientId);
    } else if (action === 'release') {
      const resource = String(command.args?.resource || '');
      if (owners.get(resource) === client.clientId) {
        owners.delete(resource);
        publishOwnership(resource, null);
      }
    } else if (action === 'release_all') {
      for (const [resource, owner] of [...owners]) {
        if (owner !== client.clientId) continue;
        owners.delete(resource);
        publishOwnership(resource, null);
      }
    }
    send(client, {v: 1, type: 'ack', id, rev: revision, result: {ok: true}});
    return;
  }

  const resource = resourceFor(command);
  if (resource) {
    const existing = owners.get(resource);
    if (existing && existing !== client.clientId) return reject(client, id, `resource ${resource} is owned by another client`);
    if (!existing) {
      owners.set(resource, client.clientId);
      publishOwnership(resource, client.clientId);
    }
  }

  const paramId = String(command.args?.id || '');
  if (paramId === 'reject_me') return reject(client, id, 'fixture rejected parameter command');
  if (paramId === 'timeout_me') return reject(client, id, 'matron acknowledgement timeout');
  if (command.target === 'param' && command.action === 'describe') {
    send(client, {v: 1, type: 'ack', id, rev: revision, result: {param: paramDescriptor(paramId)}});
    return;
  }
  if (command.target === 'param' && command.action === 'set_normalized') {
    const normalized = Number(command.args?.value);
    send(client, {v: 1, type: 'ack', id, rev: revision, result: {param: paramDescriptor(paramId, normalized)}});
    return;
  }
  send(client, {v: 1, type: 'ack', id, rev: revision, result: {ok: true}});
}

function handleMessage(client, message) {
  protocolEvents.push({client_id: client.clientId, type: message?.type});
  if (message?.type === 'hello') {
    client.clientId = String(message.client_id || `fixture-${connectionCount}`);
    send(client, {
      v: 1,
      type: 'hello',
      server: 'ingenue-browser-fixture',
      client_id: client.clientId,
      capabilities: {
        ack: 'lua-applied',
        channels: ['device', 'control', 'script', 'grid', 'arc', 'params', 'ownership'],
        commands: ['control.key', 'control.enc', 'grid.key', 'grid.configure', 'arc.key', 'arc.delta', 'arc.configure', 'param.set', 'param.set_normalized', 'gamepad.button'],
      },
    });
    return;
  }
  if (message?.type === 'subscribe' || message?.type === 'resync') {
    if (message.type === 'subscribe') subscriptionCount += 1;
    send(client, {v: 1, type: 'snapshot', rev: revision, state: fixtureState()});
    return;
  }
  if (message?.type === 'heartbeat') {
    send(client, {v: 1, type: 'heartbeat', ts: Date.now() / 1000});
    return;
  }
  if (message?.type === 'command') {
    commands.push({client_id: client.clientId, id: message.id, command: message.command});
    acknowledge(client, message);
  }
}

function consumeFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (client.buffer.length < 10) return;
      const large = client.buffer.readBigUInt64BE(2);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('fixture frame is too large');
      length = Number(large);
      offset = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (client.buffer.length < offset + maskLength + length) return;
    const mask = masked ? client.buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
    client.buffer = client.buffer.subarray(offset + length);
    if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    if (opcode === 0x8) {
      client.socket.end(websocketFrame(Buffer.alloc(0), 0x8));
      return;
    }
    if (opcode === 0x9) {
      client.socket.write(websocketFrame(payload, 0xA));
      continue;
    }
    if (opcode !== 0x1) continue;
    try {
      handleMessage(client, JSON.parse(payload.toString('utf8')));
    } catch (error) {
      reject(client, 'invalid', `fixture protocol error: ${error.message}`);
    }
  }
}

const realtimeServer = createServer();
realtimeServer.on('upgrade', (request, socket) => {
  if (new URL(request.url || '/', `http://${request.headers.host || HOST}`).pathname !== '/realtime') {
    socket.destroy();
    return;
  }
  const key = request.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));
  connectionCount += 1;
  const client = {socket, clientId: null, buffer: Buffer.alloc(0), heartbeat: null};
  clients.add(client);
  client.heartbeat = setInterval(() => send(client, {v: 1, type: 'heartbeat', ts: Date.now() / 1000}), 1000);
  socket.on('data', chunk => consumeFrames(client, chunk));
  const cleanup = () => {
    clearInterval(client.heartbeat);
    clients.delete(client);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

const staticServer = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || HOST}`);
  if (url.pathname === '/__fixture__/reset') {
    commands = [];
    protocolEvents = [];
    owners.clear();
    revision = 1;
    return jsonResponse(response, {ok: true});
  }
  if (url.pathname === '/__fixture__/commands') return jsonResponse(response, commands);
  if (url.pathname === '/__fixture__/stats') {
    return jsonResponse(response, {
      connections: connectionCount,
      subscriptions: subscriptionCount,
      active_clients: clients.size,
      protocol_events: protocolEvents,
    });
  }
  if (url.pathname === '/__fixture__/disconnect') {
    for (const client of [...clients]) client.socket.destroy();
    return jsonResponse(response, {ok: true});
  }
  if (url.pathname === '/favicon.ico') {
    response.writeHead(204, {'cache-control': 'no-store'});
    response.end();
    return;
  }
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/midi.html';
  const candidate = path.resolve(WEB_ROOT, `.${pathname}`);
  if (!candidate.startsWith(`${WEB_ROOT}${path.sep}`)) {
    response.writeHead(403);
    response.end('forbidden');
    return;
  }
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) throw new Error('not a file');
    const body = await readFile(candidate);
    response.writeHead(200, {
      'content-type': MIME.get(path.extname(candidate).toLowerCase()) || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
    response.end('not found');
  }
});

await new Promise(resolve => staticServer.listen(STATIC_PORT, HOST, resolve));
await new Promise(resolve => realtimeServer.listen(REALTIME_PORT, HOST, resolve));

const python = spawn(process.env.PYTHON || 'python3', [
  path.join(ROOT, 'web', 'midi-local.py'),
  '--device', HOST,
  '--device-port', String(STATIC_PORT),
  '--realtime-port', String(REALTIME_PORT),
  '--local-port', String(BRIDGE_PORT),
], {stdio: 'inherit'});

python.on('exit', code => {
  if (code && code !== 0) {
    console.error(`localhost bridge exited with code ${code}`);
    process.exitCode = code;
  }
});

async function shutdown() {
  python.kill('SIGTERM');
  for (const client of [...clients]) client.socket.destroy();
  await Promise.all([
    new Promise(resolve => staticServer.close(resolve)),
    new Promise(resolve => realtimeServer.close(resolve)),
  ]);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown().finally(() => process.exit(0)));
}

console.log(`Ingenue browser fixture: http://${HOST}:${STATIC_PORT}, ws://${HOST}:${REALTIME_PORT}, bridge http://${HOST}:${BRIDGE_PORT}`);
