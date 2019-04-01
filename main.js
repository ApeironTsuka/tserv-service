'use strict';
const fs = require('fs'),
      net = require('net'),
      eachline = require('eachline'),
      { EventEmitter } = require('events'),
      glob = require('glob'),
      cwd = process.cwd();

let noProcess = !process.send, debugMode = false;

function debugPrint(...args) { if (debugMode) { console.log(...args); } }
function reparsePath(p) {
  if (! /(\.\/|\/\/)/.test(p)) { return p; }
  let a = p.split(/\//), a2 = [], out = '';
  for (let i = 0, l = a.length; i < l; i++) {
    if ((a[i] == '.') || (a[i] == '')) { continue; }
    else if (a[i] == '..') { a2.pop(); }
    else { a2.push(a[i]); }
  }
  if (a2.length == 0) { return '/'; }
  a = a2.join('/');
  if (! /^\//.test(a)) { a = '/'+a; }
  return a;
}
class ServiceNotFoundError extends Error {
  constructor(s) {
    super();
    this.name = 'ServiceNotFoundError';
    this.service = s;
    this.message = (s ? `Service "${s}" not found` : 'Service not found');
  }
}
function checkPath(p) {
  let found = false, out;
  try { out = require.resolve(p); found = true; } catch (err) { }
  if (found) { return out; }
  return '';
}
function findApi(nn, spath) {
  let p, n = nn.replace(/(\.\.|\\|\/)/g, '');
  if ((p = checkPath(`${spath}/service/api/${n}.js`)) != '') { return p; }
  if ((p = checkPath(`${cwd}/service/api/${n}.js`)) != '') { return p; }
  if ((p = checkPath(`${__dirname}/../../services/api/${n}.js`)) != '') { return p; }
  let statCache = {}, exts = glob.sync(`${cwd}/extensions/*`, { stat: true, statCache });
  for (let i = 0, l = exts.length; i < l; i++) {
    if (!statCache[exts[i]].isDirectory()) { continue; }
    if ((p = checkPath(`${exts[i]}/services/api/${n}.js`)) != '') { return p; }
  }
  return '';
}
function findApiExt(nn, ee, spath) {
  let p, n = nn.replace(/(\.\.|\\|\/)/g, ''), e = ee.replace(/(\.\.|\\|\/)/g, '');
  if ((p = checkPath(`${spath}/services/api/${n}-${e}.js`)) != '') { return p; }
  if ((p = checkPath(`${spath}/services/api/_${e}.js`)) != '') { return p; }
  if ((p = checkPath(`${cwd}/services/api/${n}-${e}.js`)) != '') { return p; }
  if ((p = checkPath(`${cwd}/services/api/_${e}.js`)) != '') { return p; }
  if ((p = checkPath(`${__dirname}/../../services/api/${n}-${e}.js`)) != '') { return p; }
  if ((p = checkPath(`${__dirname}/../../services/api/_${e}.js`)) != '') { return p; }
  let statCache = {}, exts = glob.sync(`${cwd}/extensions/*`, { stat: true, statCache });
  for (let i = 0, l = exts.length; i < l; i++) {
    if (!statCache[exts[i]].isDirectory()) { continue; }
    if ((p = checkPath(`${exts[i]}/services/api/${n}-${e}.js`)) != '') { return p; }
    if ((p = checkPath(`${exts[i]}/services/api/_${e}.js`)) != '') { return p; }
  }
  return '';
}
class extendedApiBaseClass {
  constructor(p) { this._events = []; this.p = p; }
  on(n, f) { this._events.push({ n, f }); this.p.on(n, f); }
  off(n, f) {
    for (let i = 0, e = this._events, l = e.length; i < l; i++) { if ((e[i].n == n) && (e[i].f == f)) { e.splice(i, 1); i--; l--; } }
    this.p.off(n, f);
  }
}
class serviceEmitter extends EventEmitter {
  constructor(con) {
    super();
    this.eventIDs = 0;
    this.eventHandlers = {};
    this.handled = {};
    this.elCount = {};
    this.elFired = {};
    this.boundMap = {};
    this.socket = (con ? con : undefined);
  }
  init(sn, o) {
    let keep, port = 0;
    if ((typeof o === 'boolean') || (o instanceof Boolean)) { keep = !!o; }
    else { keep = !!o.keep; port = o.port||0; }
    this.connections = { _count: 0 };
    let sockClosed = (k) => {
      if (k.ceFired) { return; }
      k.ceFired = true;
      k.emit('disconnected');
    };
    this.type = sn;
    this.server = net.createServer((c) => {
      let k = new serviceEmitter(c);
      eachline(c, (...args) => serviceEmitter.dataHandler.call(k, this, ...args));
      k.ceFired = false;
      c.on('end', () => sockClosed(k));
      c.on('close', () => sockClosed(k));
      c.on('error', () => sockClosed(k));
      c._write_ = c.write;
      c.write = (...args) => { if (k.ceFired) { return; } debugPrint('writing', args[0]); args[0]+='\n'; return c._write_(...args); };
      k.type = sn;
      k.fromServer = true;
      k.server = this;
      this.connections._count++;
      k.on('disconnected', function () {
        let { id, server: { connections: cons } } = this;
        if (!cons[id]) { return; }
        delete cons[id];
        cons._count--;
        if ((cons._count == 0) && (!keep)) { this.exit(); }
      });
      c.write(JSON.stringify({ type: 'init', data: {} }), 'utf8', () => { debugPrint('sent init'); });
    });
    this.server.listen(port, () => { if (noProcess) { return; } process.send({ type: 'port', port: this.port }); });
    this.port = this.server.address().port;
    if (!noProcess) { process.on('message', this.PL = (m) => this.processListener(m)); }
  }
  connectToP(name, port) { this.connectTo({ name, port }); }
  connectTo(sn, h, e) {
    let s = sn, p, temp = {};
    if (!this.id) { return; } // FIXME
    this.isP = false;
    if (sn.port) { s = sn.name; p = sn.port; this.isP = true; }
    else { // FIXME add other search paths
      if (sn.servicePath) { s = sn.name; this.servicePath = reparsePath(sn.servicePath); }
      p = `${this.servicePath||cwd}/services/ports/${s}.port`;
      if (!fs.existsSync(p)) { debugPrint('cwd failed'); }
      debugPrint(p);
      try { p = parseInt(fs.readFileSync(p, 'utf8').toString()); }
      catch (e) { p = undefined; }
    }
    this._port = p;
    if (this.api) { delete this.api; }
    for (let i = 0, keys = Object.keys(this._events), l = keys.length; i < l; i++) {
      switch (keys[i]) {
        case 'ready': case 'error': case 'disconnect': case 'reconnect': case 'reconnected': temp[keys[i]] = this._events[keys[i]]; break;
        default: break;
      }
    }
    this._events = temp;
    if (h) { this.once('ready', h); }
    if (e) { this.on('error', e); }
    this.type = s;
    if (!this.socket) {
      this.hid = serviceEmitter.ids++;
      this._pmservHdlr = (m) => {
        switch (m.type) {
          case 'service': this._handleService(m); break;
          default: break;
        }
      };
      if (!this._port) { if (!noProcess) { process.on('message', (m) => this._pmservHdlr(m)); process.send({ type: 'service event', id: this.hid, service: this.type, name: 'start' }); } }
      else { this._handleService({ name: 'port', id: this.hid, port: this._port }); }
      return true;
    }
    return false;
  }
  setIdentifier(id) { this.id = id; }
  // { id: eventId, event: 'event name', data: {} }
  // m = { event: 'event name', data: {}, callback: () => {} }
  send(m) {
    let hid = serviceEmitter.ids++, p;
    if (m.callback) { this.eventHandlers[`__reply_${hid}`] = (...args) => m.callback.call(this, ...args); }
    p = JSON.stringify({ type: 'msg', event: m.event, id: hid, data: m.data });
    this.socket.write(p, 'utf8', () => { });
  }
  disconnect() { if (!this.isConnected) { return; } this.isConnected = false; this.socket.end(); }
  destroy() { if (!noProcess) { return; } process.removeListener('message', this.PL); }
  isHandled(n) { return !!this.handled[n]; }
  handle(n) { this.handled[n] = true; }
  exit() {
    this.server.close();
    if (noProcess) { return; }
    process.send({ type: 'stop' });
  }
  loadApi() {
    let p = findApi(this.type, this.servicePath), o;
    if (!p) { debugPrint('cwd failed load', this.type); return undefined; }
    if (this.api) { return; }
    try { o = require(p); }
    catch (e) { debugPrint(e.stack); return undefined; }
    return o(this, (!!this.server || !!this.fromServer));
  }
  extendApi(n) {
    let o, p = findApiExt(this.type, n, this.servicePath);
    if (!p) { debugPrint('cwd failed extend', this.type, n); return undefined; }
    if (this.api[n]) { return; }
    try { o = require(p); }
    catch (e) { debugPrint(e.stack); return false; }
    let api = this.api[n] = new extendedApiBaseClass(this);
    api = o(this.api, api, (!!this.server || !!this.fromServer));
    if (api) { this.api[n] = typeof api == 'function' ? new api(this) : api; }
    return true;
  }
  cleanApi(n) {
    if (!this.api[n]) { return; }
    for (let i = 0, e = this.api[n]._events, l = e.length; i < l; i++) { this.off(e[i].n, e[i].f); }
    delete this.api[n];
  }
  
  _uidf() { return serviceEmitter.uidf(); }
  reparsePath(...args) { return reparsePath(...args); }
  processListener(m) {
    if (m.type == 'go') { this.emit('init'); }
    else if (m.type == 'stop') {
      debugPrint('exiting...');
      this.emit('exit');
      setTimeout(() => process.exit(), 1000);
    }
  }
  _handleService(m) {
    if (this.hid != m.id) { return; }
    if ((this._pmservHdlr) && (!noProcess)) {
      process.removeListener('message', this._pmservHdlr);
      delete this._pmservHdlr;
    }
    switch (m.name) {
      case 'port':
        this.socket = net.connect({ host: 'localhost', port: m.port }, () => {
          this.isConnected = true;
          if (this._reconnected) { this.emit('reconnected'); this._reconnected = false; }
        })
        // FIXME handle connection closure better (retry connection 3 times before firing a 'disconnected' event?)
        .on('close', () => {
          if (!this.isConnected) { return; }
          this.isConnected = false;
          this.emit('disconnected');
          // Automatically reconnect when .connectTo was used without a port
          delete this.socket;
          if (!this.isP) { setTimeout(() => { this._reconnected = true; this.connectTo(this.type); }, 5000); }
          // Otherwise, tell the user to reconnect manually
          else { this.emit('reconnect'); }
        })
        .on('error', (e) => {
          if (!this.isConnected) { return; }
          this.isConnected = false;
          this.emit('error', e);
        });
        this.socket._write_ = this.socket.write;
        this.socket.write = (...args) => { if (!this.isConnected) { return; } debugPrint('sent', args[0]); args[0]+='\n'; return this.socket._write_(...args); };
        eachline(this.socket, (...args) => serviceEmitter.dataHandler.call(this, undefined, ...args));
        break;
      case 'none': this.emit('error', new ServiceNotFoundError(m.service)); break;
      case 'error': if (m.e == 'NoService') { this.emit('error', new ServiceNoTfoundError(m.service)); } break;
      default: break;
    }
  }
}
serviceEmitter.ids = 0;
serviceEmitter.uidf = function () { return (Math.floor(Math.random()*15728640)+1048576).toString(16); };
serviceEmitter.dataHandler = function (serv, data) {
  if (data.length == 0) { return; }
  debugPrint('reading', data);
  let d;
  try { d = JSON.parse(data); } catch (e) { debugPrint(e); return; } // FIXME
  function replyFunc(id, m) { this.socket.write(JSON.stringify({ type: 'reply', id, data: m===undefined?false:m }), 'utf8', () => {}); }
  switch (d.type) {
    case 'msg':
      this.handled[d.event] = false;
      this.elFired[d.event] = 0;
      this.emit(d.event, d.data, (...args) => replyFunc.call(this, d.id, ...args));
      break;
    case 'reply':
      if (this.eventHandlers[`__reply_${d.id}`]) {
        this.eventHandlers[`__reply_${d.id}`](d.data);
        delete this.eventHandlers[`__reply_${d.id}`];
      }
      break;
    case 'stop':
      if (serv) { return; }
      this.emit('stop');
      this.disconnect();
      break;
    case 'init':
      if (serv) {
        this.id = d.id;
        if (serv.connections[d.id]) { this.socket.write(JSON.stringify({ type: 'init_nck' }), 'utf8', () => {}); return; }
        serv.connections[d.id] = this;
        this.socket.write(JSON.stringify({ type: 'init_ack' }), 'utf8', () => {});
        serv.emit('connection', this);
      } else { this.socket.write(JSON.stringify({ type: 'init', id: this.id }), 'utf8', () => {}); }
      break;
    case 'init_ack': if (!serv) { this.ready = true; this.emit('ready'); } break;
    case 'init_nck': if (!serv) { this.emit('nck'); } break;
    default: break;
  }
};
module.exports = { serviceEmitter, reparsePath, set debug(v) { debugMode = !!v; }, extendedApiBaseClass };
