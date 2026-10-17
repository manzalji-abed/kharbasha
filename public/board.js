// Shared drawing surface. Every client uses the same logical size and backing-store
// scale, so replaying the same ops (including flood fills) gives the same picture.
export const W = 800;
export const H = 600;
const SCALE = 1.5;
const FILL_TOLERANCE = 100; // summed RGB distance, swallows anti-aliased edges

export class Board {
  constructor(canvas, onOp) {
    this.canvas = canvas;
    this.onOp = onOp;
    canvas.width = W * SCALE;
    canvas.height = H * SCALE;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.ops = [];
    this.active = null; // stroke currently receiving points
    this.local = null; // stroke the local pointer is drawing
    this.enabled = false;
    this.tool = 'pen';
    this.color = '#000000';
    this.size = 6;
    this.nextId = Math.floor(Math.random() * 1e6);
    this.reset();
    this.bind();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.local = null;
    this.canvas.classList.toggle('can-draw', on);
  }

  reset() {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  // ------------------------------------------------------------- rendering

  apply(op) {
    switch (op.k) {
      case 'b':
        this.active = { k: 's', i: op.i, c: op.c, s: op.s, p: op.p.slice(0, 2) };
        this.ops.push(this.active);
        this.dot(op.c, op.s, op.p[0], op.p[1]);
        break;
      case 'm': {
        const st = this.active;
        if (!st || st.i !== op.i) return;
        const from = st.p.length;
        st.p.push(...op.p);
        this.line(st, from);
        break;
      }
      case 'f':
        this.active = null;
        this.ops.push({ k: 'f', x: op.x, y: op.y, c: op.c });
        this.fill(op.x, op.y, op.c);
        break;
      case 'u':
        this.ops.pop();
        this.active = null;
        this.redraw();
        break;
      case 'x':
        this.ops = [];
        this.active = null;
        this.local = null;
        this.reset();
        break;
    }
  }

  load(ops) {
    this.ops = ops.map(op => (op.k === 's' ? { ...op, p: [...op.p] } : { ...op }));
    const last = this.ops.at(-1);
    this.active = last?.k === 's' ? last : null;
    this.redraw();
  }

  redraw() {
    this.reset();
    for (const op of this.ops) {
      if (op.k === 'f') {
        this.fill(op.x, op.y, op.c);
      } else {
        this.dot(op.c, op.s, op.p[0], op.p[1]);
        if (op.p.length > 2) this.line(op, 2);
      }
    }
  }

  dot(color, size, x, y) {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Strokes the polyline from point index `from` (a flat-array offset) to the end.
  line(stroke, from) {
    const { ctx } = this;
    const p = stroke.p;
    ctx.strokeStyle = stroke.c;
    ctx.lineWidth = stroke.s;
    ctx.beginPath();
    ctx.moveTo(p[from - 2], p[from - 1]);
    for (let j = from; j < p.length; j += 2) ctx.lineTo(p[j], p[j + 1]);
    ctx.stroke();
  }

  // Scanline flood fill in backing-store pixels.
  fill(lx, ly, hex) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const sx = Math.min(w - 1, Math.floor(lx * SCALE));
    const sy = Math.min(h - 1, Math.floor(ly * SCALE));
    const img = this.ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const s0 = (sy * w + sx) * 4;
    const [tr, tg, tb] = [d[s0], d[s0 + 1], d[s0 + 2]];
    if (Math.abs(tr - r) + Math.abs(tg - g) + Math.abs(tb - b) < 8) return;

    const seen = new Uint8Array(w * h);
    const match = i => !seen[i] && Math.abs(d[i * 4] - tr) + Math.abs(d[i * 4 + 1] - tg) + Math.abs(d[i * 4 + 2] - tb) <= FILL_TOLERANCE;
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop();
      let x = stack.pop();
      let i = y * w + x;
      while (x > 0 && match(i - 1)) { x--; i--; }
      let up = false;
      let down = false;
      for (; x < w && match(i); x++, i++) {
        seen[i] = 1;
        d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
        if (y > 0) {
          const m = match(i - w);
          if (m && !up) stack.push(x, y - 1);
          up = m;
        }
        if (y < h - 1) {
          const m = match(i + w);
          if (m && !down) stack.push(x, y + 1);
          down = m;
        }
      }
    }
    this.ctx.putImageData(img, 0, 0);
  }

  // ------------------------------------------------------------- local input

  bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this.down(e));
    c.addEventListener('pointermove', e => this.move(e));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) c.addEventListener(type, () => this.up());
    setInterval(() => this.flush(), 50); // ~20 messages/s while drawing keeps usage within free limits
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) * W) / r.width);
    const y = Math.round(((e.clientY - r.top) * H) / r.height);
    return [Math.min(W, Math.max(0, x)), Math.min(H, Math.max(0, y))];
  }

  emit(op) {
    this.apply(op);
    this.onOp(op);
  }

  down(e) {
    if (!this.enabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    const [x, y] = this.pos(e);
    if (this.tool === 'fill') return this.emit({ k: 'f', x, y, c: this.color });
    this.canvas.setPointerCapture(e.pointerId);
    const i = (this.nextId = (this.nextId + 1) % 1e9);
    this.local = { i, x, y, buf: [] };
    this.emit({ k: 'b', i, c: this.tool === 'eraser' ? '#ffffff' : this.color, s: this.size, p: [x, y] });
  }

  move(e) {
    const l = this.local;
    if (!l) return;
    const events = e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e];
    const pts = [];
    for (const ev of events) {
      const [x, y] = this.pos(ev);
      if (Math.abs(x - l.x) + Math.abs(y - l.y) < 2) continue;
      l.x = x;
      l.y = y;
      pts.push(x, y);
    }
    if (!pts.length) return;
    this.apply({ k: 'm', i: l.i, p: pts });
    l.buf.push(...pts);
    if (l.buf.length >= 300) this.flush();
  }

  // Points are drawn locally at once but sent in small batches to keep traffic low.
  flush() {
    const l = this.local;
    if (!l?.buf.length) return;
    this.onOp({ k: 'm', i: l.i, p: l.buf });
    l.buf = [];
  }

  up() {
    if (!this.local) return;
    this.flush();
    this.local = null;
  }

  undo() {
    if (!this.enabled || !this.ops.length) return;
    this.up();
    this.emit({ k: 'u' });
  }

  clear() {
    if (!this.enabled) return;
    this.up();
    this.emit({ k: 'x' });
  }
}
