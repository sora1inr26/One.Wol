const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const os = require('os');

const PORT = process.env.PORT || 3000;
const PKGVAR = process.env.TRIM_PKGVAR || path.join(__dirname, 'data');
const DATA_FILE = path.join(PKGVAR, 'macs.json');

// Ensure data directory
try {
  fs.mkdirSync(PKGVAR, { recursive: true });
} catch (e) {}

function loadMacs() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    return [];
  }
}

function saveMacs(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function normalizeMac(mac) {
  return mac.toLowerCase().replace(/[^0-9a-f]/g, '');
}

function macToBuffer(mac) {
  const s = normalizeMac(mac);
  if (s.length !== 12) throw new Error('Invalid MAC');
  const buf = Buffer.alloc(6 + 16 * 6);
  for (let i = 0; i < 6; i++) buf[i] = 0xff;
  const macBytes = Buffer.from(s, 'hex');
  for (let i = 0; i < 16; i++) macBytes.copy(buf, 6 + i * 6);
  return buf;
}

function ipToInt(ip) {
  return ip.split('.').map(n => parseInt(n, 10)).reduce((acc, v) => (acc<<8) + v, 0) >>> 0;
}

function intToIp(i) {
  return [(i>>>24)&0xFF, (i>>>16)&0xFF, (i>>>8)&0xFF, i&0xFF].join('.');
}

// return true for interfaces commonly used by virtualization/bridges/containers
function isVirtualInterface(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  const prefixes = ['vnet', 'veth', 'docker', 'br-', 'virbr', 'tun', 'tap', 'vmnet', 'vmbr', 'lo', 'ovs', 'ifb', 'docker0'];
  for (const p of prefixes) {
    if (n.startsWith(p)) return true;
  }
  return false;
}

function sendWake(mac) {
  return new Promise((resolve, reject) => {
    const packet = macToBuffer(mac);

    // collect local IPv4 non-internal physical interfaces
    const nets = os.networkInterfaces();
    const targets = [];
    Object.keys(nets).forEach((name) => {
      if (isVirtualInterface(name)) return; // skip virtual/bridge interfaces by name
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal && net.address && net.netmask) {
          try {
            const addrInt = ipToInt(net.address);
            const maskInt = ipToInt(net.netmask);
            const bcastInt = (addrInt & maskInt) | (~maskInt >>> 0);
            const bcast = intToIp(bcastInt);
            // skip global limited broadcast
            if (bcast === '255.255.255.255') continue;
            targets.push({ iface: name, address: net.address, broadcast: bcast });
          } catch (e) {
            // ignore parsing errors
          }
        }
      }
    });

    if (targets.length === 0) return reject(new Error('no local network interfaces found'));

    const client = dgram.createSocket('udp4');
    let pending = targets.length;
    let hadError = false;

    client.on('error', (err) => { hadError = true; client.close(); reject(err); });

    client.bind(() => {
      try { client.setBroadcast(true); } catch (e) {}
      targets.forEach((t) => {
        client.send(packet, 0, packet.length, 9, t.broadcast, (err) => {
          if (err) hadError = true;
          pending -= 1;
          if (pending === 0) {
            client.close();
            if (hadError) reject(new Error('one or more sends failed')); else resolve();
          }
        });
      });
    });
  });
}

function jsonResponse(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}

function getNetworkInfo() {
  const nets = os.networkInterfaces();
  const results = [];
  Object.keys(nets).forEach((name) => {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && !isVirtualInterface(name)) {
        // calculate network address and prefix length from net.netmask
        const octets = net.address.split('.').map(n => parseInt(n,10));
        const maskOctets = net.netmask.split('.').map(n => parseInt(n,10));
        const addrInt = octets.reduce((acc, v) => (acc<<8) + v, 0) >>> 0;
        const maskInt = maskOctets.reduce((acc, v) => (acc<<8) + v, 0) >>> 0;
        const netInt = (addrInt & maskInt) >>> 0;
        const netAddr = [(netInt>>>24)&0xFF, (netInt>>>16)&0xFF, (netInt>>>8)&0xFF, netInt&0xFF].join('.');
        // prefix length
        const prefix = maskOctets.map(o=>o.toString(2).split('1').length-1).reduce((a,b)=>a+b,0);
        results.push({ iface: name, address: net.address, netmask: net.netmask, cidr: netAddr + '/' + prefix });
      }
    }
  });
  return results;
}

const mime = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.json': 'application/json'
};

function serveStatic(req, res) {
  let p = req.url === '/' ? '/index.html' : req.url;
  // strip query
  p = p.split('?')[0];
  const file = path.join(__dirname, 'ui', p.replace(/^\/+/, ''));
  if (!file.startsWith(path.join(__dirname, 'ui'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  // serve static UI files under / or /index.html
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/index.html') || req.url.startsWith('/app.js') || req.url.startsWith('/ui/') )) {
    return serveStatic(req, res);
  }
  if (req.method === 'GET' && req.url === '/macs') {
    return jsonResponse(res, loadMacs());
  }

  if (req.method === 'GET' && req.url === '/network') {
    try {
      return jsonResponse(res, getNetworkInfo());
    } catch (e) {
      return jsonResponse(res, { error: e.message }, 500);
    }
  }

  if (req.method === 'POST' && req.url === '/macs') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { mac, name } = JSON.parse(body || '{}');
      if (!mac) return jsonResponse(res, { error: 'mac required' }, 400);
      const list = loadMacs();
      const nmac = normalizeMac(mac);
      if (list.find((i) => normalizeMac(i.mac) === nmac)) return jsonResponse(res, { error: 'exists' }, 409);
      list.push({ mac, name: name || '' });
      saveMacs(list);
      return jsonResponse(res, { ok: true }, 201);
    } catch (e) {
      return jsonResponse(res, { error: e.message }, 400);
    }
  }

  if (req.method === 'DELETE' && req.url.startsWith('/macs/')) {
    const mac = decodeURIComponent(req.url.substring('/macs/'.length));
    const nmac = normalizeMac(mac);
    const list = loadMacs();
    const newList = list.filter((i) => normalizeMac(i.mac) !== nmac);
    if (newList.length === list.length) return jsonResponse(res, { error: 'not found' }, 404);
    saveMacs(newList);
    return jsonResponse(res, { ok: true });
  }

  if (req.method === 'PUT' && req.url.startsWith('/macs/')) {
    const mac = decodeURIComponent(req.url.substring('/macs/'.length));
    let body = '';
    for await (const chunk of req) body += chunk;
    let name;
    try { name = JSON.parse(body || '{}').name; } catch (e) { }
    if (name === undefined) return jsonResponse(res, { error: 'name required' }, 400);
    const list = loadMacs();
    const nmac = normalizeMac(mac);
    let found = false;
    for (let i = 0; i < list.length; i++) {
      if (normalizeMac(list[i].mac) === nmac) { list[i].name = name; found = true; break; }
    }
    if (!found) return jsonResponse(res, { error: 'not found' }, 404);
    saveMacs(list);
    return jsonResponse(res, { ok: true });
  }

  if (req.method === 'POST' && req.url.startsWith('/wake')) {
    // POST /wake or POST /wake/:mac
    let mac = null;
    if (req.url.startsWith('/wake/')) {
      mac = decodeURIComponent(req.url.substring('/wake/'.length));
    } else {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { mac = JSON.parse(body || '{}').mac; } catch (e) { }
    }
    if (!mac) return jsonResponse(res, { error: 'mac required' }, 400);
    try {
      await sendWake(mac);
      return jsonResponse(res, { ok: true });
    } catch (e) {
      return jsonResponse(res, { error: e.message }, 500);
    }
  }

  jsonResponse(res, { error: 'not found' }, 404);
});

server.listen(PORT, () => {
  console.log('OneWol listening on', PORT);
});
