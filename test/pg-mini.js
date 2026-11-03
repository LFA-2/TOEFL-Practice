// Minimal PostgreSQL client for local tests only (trust auth over a Unix socket, extended query protocol).
// Values are converted the way postgres.js does it, so type mistakes show up locally:
// int8/numeric come back as strings, date/timestamp as Date objects, json/jsonb parsed.
'use strict';
const net = require('node:net');

const PARSERS = {
  16: v => v === 't', 20: v => v, 21: Number, 23: Number, 26: Number, 700: Number, 701: Number, 1700: v => v,
  114: JSON.parse, 3802: JSON.parse, 1082: v => new Date(v), 1114: v => new Date(v), 1184: v => new Date(v),
};

class Conn {
  constructor({ socketPath, user = 'postgres', database }) {
    this.opts = { socketPath, user, database };
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.current = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.createConnection(this.opts.socketPath);
      this.sock.on('error', reject);
      this.sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
      this.sock.on('connect', () => {
        const params = Buffer.from(`user\0${this.opts.user}\0database\0${this.opts.database}\0\0`);
        const head = Buffer.alloc(8);
        head.writeInt32BE(8 + params.length, 0); head.writeInt32BE(196608, 4);
        this.sock.write(Buffer.concat([head, params]));
        this.collect().then(resolve, reject);
      });
    });
  }

  pump() {
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < 1 + len) return;
      const msg = { type: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, 1 + len) };
      this.buf = this.buf.subarray(1 + len);
      this.current.push(msg);
      if (msg.type === 'Z') { const w = this.waiters.shift(); const msgs = this.current; this.current = []; w(msgs); }
    }
  }

  collect() {
    this.current = this.current || [];
    return new Promise(res => this.waiters.push(res)).then(msgs => {
      const err = msgs.find(m => m.type === 'E');
      if (err) {
        const fields = {};
        for (const part of err.body.toString().split('\0')) if (part) fields[part[0]] = part.slice(1);
        const e = new Error(fields.M); e.code = fields.C; throw e;
      }
      return msgs;
    });
  }

  msg(type, ...parts) {
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(5);
    head.write(type, 0); head.writeInt32BE(4 + body.length, 1);
    return Buffer.concat([head, body]);
  }

  async simple(text) {
    this.sock.write(this.msg('Q', Buffer.from(text + '\0')));
    await this.collect();
  }

  async query(text, params = []) {
    const i16 = n => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
    const i32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
    const z = s => Buffer.from(s + '\0');
    const bindParams = params.map(p => (p === null || p === undefined ? i32(-1) : (b => Buffer.concat([i32(b.length), b]))(Buffer.from(String(p)))));
    this.sock.write(Buffer.concat([
      this.msg('P', z(''), z(text), i16(0)),
      this.msg('B', z(''), z(''), i16(0), i16(params.length), ...bindParams, i16(0)),
      this.msg('D', Buffer.from('P'), z('')),
      this.msg('E', z(''), i32(0)),
      this.msg('S'),
    ]));
    const msgs = await this.collect();
    const desc = msgs.find(m => m.type === 'T');
    if (!desc) return [];
    const cols = [];
    let off = 2;
    for (let i = 0; i < desc.body.readInt16BE(0); i++) {
      const end = desc.body.indexOf(0, off);
      const name = desc.body.toString('utf8', off, end);
      off = end + 1;
      cols.push({ name, oid: desc.body.readInt32BE(off + 6) });
      off += 18;
    }
    return msgs.filter(m => m.type === 'D').map(m => {
      const row = {};
      let o = 2;
      for (const c of cols) {
        const len = m.body.readInt32BE(o); o += 4;
        if (len === -1) { row[c.name] = null; continue; }
        const v = m.body.toString('utf8', o, o + len); o += len;
        row[c.name] = (PARSERS[c.oid] || (x => x))(v);
      }
      return row;
    });
  }

  end() { try { this.sock.write(this.msg('X')); this.sock.end(); } catch { /* closed */ } }
}

async function connect(opts) { const c = new Conn(opts); await c.connect(); return c; }

module.exports = { connect };
