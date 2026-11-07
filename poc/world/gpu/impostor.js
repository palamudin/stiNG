// The far trees' pictures (WebGPU): every kind and variety's level-0 card mesh (treecards.js) drawn from eight sides
// into two atlases, once at start: albedo (alpha 1 for leaves, 0.6 for wood, 0 for nothing) and the normal in the
// bake camera's frame (z toward it), as trees.js _makeFar. A far card shows the view facing the eye and is lit from
// its baked normal, so it takes the sun like the mesh it stands for.
import * as THREE from 'three/webgpu';
import { Fn, vec4, float, attribute, texture, uv, normalView, If } from 'three/tsl';
import { treeDesign, meshTreeCards } from '../treecards.js';

export function bakeImpostors(renderer, kinds, nv, atlasTex, I = 128, V = 8) {
  const rows = kinds.length * nv, W = V * I, H = rows * I;
  const mk = () => { const rt = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: true }); rt.texture.generateMipmaps = true; rt.texture.minFilter = THREE.LinearMipmapLinearFilter; rt.texture.magFilter = THREE.LinearFilter; return rt; };
  const A = mk(), N = mk();
  const leaf = attribute('aLeaf', 'float'), lf = texture(atlasTex, uv());
  const mask = Fn(() => leaf.lessThan(0.5).or(lf.a.greaterThanEqual(0.5)))();
  const matA = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  matA.maskNode = mask;
  matA.outputNode = Fn(() => {
    const c = attribute('color', 'vec3').toVar(), a = float(0.6).toVar();
    If(leaf.greaterThan(0.5), () => { c.mulAssign(lf.r.mul(lf.g)); a.assign(1); });
    return vec4(c, a);
  })();
  const matN = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  matN.maskNode = mask;
  matN.outputNode = Fn(() => {
    const n = normalView.toVar();
    If(leaf.greaterThan(0.5), () => { n.z.assign(n.z.abs()); });
    return vec4(n.mul(0.5).add(0.5), 1);
  })();
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera();
  const prev = renderer.getRenderTarget(), cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha(), ac = renderer.autoClear;
  renderer.setClearColor(0x000000, 0);
  for (const rt of [A, N]) { renderer.setRenderTarget(rt); renderer.clear(); }
  renderer.autoClear = false;
  // (a target's viewport is ignored when it equals the canvas's drawing buffer, three.js 0.186: the cells are never
  // the canvas's size in practice)
  const meta = [];
  for (let k = 0; k < kinds.length; k++) for (let v = 0; v < nv; v++) {
    const d = treeDesign(kinds[k], v + 1, { trunk: true }), m = meshTreeCards(d, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(m.col, 3)); g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
    g.setAttribute('aLeaf', new THREE.BufferAttribute(m.leaf, 1)); g.setIndex(m.idx);
    const mesh = new THREE.Mesh(g, matA); mesh.frustumCulled = false; scene.add(mesh);
    const hw = Math.max(d.crownR * 1.3, 0.6), hh = d.height * 0.5 + 0.4;
    meta.push(new THREE.Vector4(hw * 2, hh * 2, 0, 0));
    for (let s = 0; s < V; s++) {
      const a = s / V * Math.PI * 2;
      Object.assign(cam, { left: -hw, right: hw, top: hh, bottom: -hh, near: -100, far: 100 }); cam.updateProjectionMatrix();
      cam.position.set(Math.sin(a) * 50, hh - 0.4, Math.cos(a) * 50); cam.lookAt(0, hh - 0.4, 0); cam.updateMatrixWorld();
      const x = s * I, y = (k * nv + v) * I;
      for (const [rt, mt] of [[A, matA], [N, matN]]) {
        mesh.material = mt; rt.viewport.set(x, y, I, I); rt.scissor.set(x, y, I, I); rt.scissorTest = true;
        renderer.setRenderTarget(rt); renderer.clearDepth(); renderer.render(scene, cam);
      }
    }
    scene.remove(mesh); g.dispose();
  }
  for (const rt of [A, N]) { rt.viewport.set(0, 0, W, H); rt.scissor.set(0, 0, W, H); rt.scissorTest = false; }
  renderer.setRenderTarget(prev); renderer.setClearColor(cc, ca); renderer.autoClear = ac;
  matA.dispose(); matN.dispose();
  return { A, N, meta, V, rows, I };
}
