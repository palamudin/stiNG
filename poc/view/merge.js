// Meshes made from code, merged (GDD 21.4, S2): a chunk's static parts (walls, roofs, legs, posts, trunks) are put into
// bins, one per material, each part as its own geometry under a 4x4 transform with constant per-part values (a wall's
// height and footprint for its shader). A bin becomes one geometry: one draw call for every part that shares a
// material, instead of one each. Plain arrays only, no three.js, so the tests run it as they are.
//
// A geometry here is { position, normal, index } (index may be null): Float32Arrays and an integer array, as a
// three.js BufferGeometry holds them. A transform is 16 numbers, column-major (three.js Matrix4.elements).

export class Batch {
  constructor() { this.bins = new Map(); }
  // put one part into the bin `key`: `geo` placed by `m`; `vals` are constant per-part attributes, { name: [numbers] }
  add(key, geo, m, vals) {
    let b = this.bins.get(key);
    if (!b) { b = { parts: [], verts: 0, tris: 0, names: [] }; this.bins.set(key, b); }
    if (vals) for (const k of Object.keys(vals)) if (!b.names.includes(k)) b.names.push(k);
    const n = geo.position.length / 3;
    b.parts.push({ geo, m, vals });
    b.verts += n; b.tris += (geo.index ? geo.index.length : n) / 3;
    return this;
  }
  get size() { return this.bins.size; }
  // the merged arrays of each bin: { key, position, normal, index, attrs: { name: { array, itemSize } }, parts }
  build(defaults = {}) {
    const out = [];
    for (const [key, b] of this.bins) {
      const V = b.verts, pos = new Float32Array(V * 3), nor = new Float32Array(V * 3), idx = V > 65535 ? new Uint32Array(b.tris * 3) : new Uint16Array(b.tris * 3);
      const attrs = {};
      for (const name of b.names) { const d = defaults[name] || [0], sz = (b.parts.find((p) => p.vals && p.vals[name]) || { vals: { [name]: d } }).vals[name].length; attrs[name] = { array: new Float32Array(V * sz), itemSize: sz }; }
      let v = 0, t = 0;
      for (const p of b.parts) {
        const P = p.geo.position, N = p.geo.normal, I = p.geo.index, m = p.m, n = P.length / 3;
        // normals go through the inverse transpose of the upper 3x3, renormalised (scales and turns alike)
        const a = m[0], bb = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], k = m[10];
        const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g, D = -(bb * k - c * h), E = a * k - c * g, F = -(a * h - bb * g), G = bb * f - c * e, H = -(a * f - c * d), K = a * e - bb * d;
        for (let i = 0; i < n; i++) {
          const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], o = (v + i) * 3;
          pos[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
          pos[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          pos[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
          if (N) {
            const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
            let qx = A * nx + B * ny + C * nz, qy = D * nx + E * ny + F * nz, qz = G * nx + H * ny + K * nz; // the cofactor matrix: the inverse transpose times the determinant
            const det = a * A + bb * B + c * C, s = (det < 0 ? -1 : 1) / (Math.hypot(qx, qy, qz) || 1);
            nor[o] = qx * s; nor[o + 1] = qy * s; nor[o + 2] = qz * s;
          }
        }
        for (const name of b.names) {
          const at = attrs[name], val = (p.vals && p.vals[name]) || defaults[name] || new Array(at.itemSize).fill(0);
          for (let i = 0; i < n; i++) for (let j = 0; j < at.itemSize; j++) at.array[(v + i) * at.itemSize + j] = val[j];
        }
        if (I) for (let i = 0; i < I.length; i++) idx[t + i] = I[i] + v;
        else for (let i = 0; i < n; i++) idx[t + i] = v + i;
        // a mirroring transform turns the faces inside out: wind them back
        const det = a * A + bb * B + c * C;
        if (det < 0) for (let i = t; i < t + (I ? I.length : n); i += 3) { const q = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = q; }
        v += n; t += I ? I.length : n;
      }
      out.push({ key, position: pos, normal: nor, index: idx, attrs, parts: b.parts.length });
    }
    return out;
  }
}

// a column-major transform: translate (x, y, z), turned by ry about y then rx about x then rz about z (three.js's XYZ
// order of a mesh's rotation, applied as R = Rx * Ry * Rz), scaled by (sx, sy, sz)
export function place(x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) {
  const a = Math.cos(rx), b = Math.sin(rx), c = Math.cos(ry), d = Math.sin(ry), e = Math.cos(rz), f = Math.sin(rz);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  // three.js Matrix4.makeRotationFromEuler, order XYZ
  const r00 = c * e, r01 = -c * f, r02 = d;
  const r10 = af + be * d, r11 = ae - bf * d, r12 = -b * c;
  const r20 = bf - ae * d, r21 = be + af * d, r22 = a * c;
  return [r00 * sx, r10 * sx, r20 * sx, 0, r01 * sy, r11 * sy, r21 * sy, 0, r02 * sz, r12 * sz, r22 * sz, 0, x, y, z, 1];
}
