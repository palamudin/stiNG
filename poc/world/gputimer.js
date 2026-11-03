// GPU timings per pass (W3), through EXT_disjoint_timer_query_webgl2 where the browser gives it (desktop Chrome and
// Edge do; Firefox and Safari do not, and then there are no numbers, not estimates). Each pass is bracketed with a
// query; results come back a few frames later and are averaged over the last second. The CPU-side frame time says
// nothing about the GPU, which is why this exists: the stats show what each pass costs on the card in front of you.
export class GpuTimer {
  constructor(renderer) {
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.on = !!this.ext;
    this.pending = []; // { name, q }
    this.sum = new Map(); this.n = new Map(); this.ms = {}; this.t0 = performance.now();
    this.open = null;
  }
  begin(name) {
    if (!this.on || this.open) return;
    const gl = this.gl, q = gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.open = { name, q };
  }
  end() {
    if (!this.on || !this.open) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.open); this.open = null;
  }
  // call once a frame, after the passes: collects finished queries, publishes averages every second
  frame() {
    if (!this.on) return;
    const gl = this.gl, keep = [];
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) { for (const p of this.pending) gl.deleteQuery(p.q); this.pending = []; return; }
    for (const p of this.pending) {
      if (gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) {
        const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT); gl.deleteQuery(p.q);
        this.sum.set(p.name, (this.sum.get(p.name) || 0) + ns / 1e6); this.n.set(p.name, (this.n.get(p.name) || 0) + 1);
      } else keep.push(p);
    }
    this.pending = keep;
    if (performance.now() - this.t0 > 1000) {
      const out = {}; let total = 0;
      for (const [k, v] of this.sum) { out[k] = v / this.n.get(k); total += out[k]; }
      out.total = total; this.ms = out; this.sum.clear(); this.n.clear(); this.t0 = performance.now();
    }
  }
}
