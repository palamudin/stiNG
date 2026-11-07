// The demo's side panel past the first sliders (gpu/demo.js): the weather and the season, and the water's look (the
// template's 'Water' panel, index.js waterCtl). Plain DOM, built into the HUD; it writes into the state it is given.
//   state.auto        the weather follows the clock and the season (seasons.js weatherAt); else the sliders hold it
//   state.day         the day of the year (0 the first of spring)
//   state.waterAuto   the weather and the season move the water from the panel's settings (rain: silt and murk,
//                     summer: the algae, winter: clearer, the wind: more whitecaps)
//   state.look        the water's settings (gpu/water.js GLOOK)
import { GLOOK, GWATER_PRESETS } from './water.js';
import { seasonName } from '../seasons.js';

const css = `
#hud details { margin-top: 8px; } #hud summary { cursor: pointer; color: #f5c542; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; }
#hud .grid { display: grid; gap: 4px; margin-top: 6px; max-height: 46vh; overflow: auto; padding-right: 4px; }
#hud .seg { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
#hud .seg button { font: 11px system-ui; background: #1b2430; color: #cfd8e3; border: 1px solid #2c3a4a; border-radius: 4px; padding: 2px 6px; cursor: pointer; }
#hud .seg button.on { background: #f5c542; color: #15130f; border-color: #f5c542; }
#hud .chk { display: flex; gap: 6px; align-items: center; }
`;

export function buildPanel(hud, state, onChange = () => {}) {
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  state.look = state.look || { ...GLOOK };
  const outs = [];
  const section = (title, open = false) => { const d = document.createElement('details'); d.open = open; d.innerHTML = `<summary>${title}</summary>`; const g = document.createElement('div'); g.className = 'grid'; d.appendChild(g); hud.querySelector('p.note').before(d); return g; };
  const slider = (box, obj, key, label, lo, hi, step, fmt = (v) => v.toFixed(2)) => {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<label>${label}</label><input type="range" min="${lo}" max="${hi}" step="${step}"><output></output>`;
    const el = row.querySelector('input'), o = row.querySelector('output');
    el.value = obj[key]; o.textContent = fmt(obj[key]);
    el.addEventListener('input', () => { obj[key] = parseFloat(el.value); o.textContent = fmt(obj[key]); onChange(key); });
    outs.push(() => { if (document.activeElement !== el) { el.value = obj[key]; o.textContent = fmt(obj[key]); } });
    box.appendChild(row); return el;
  };
  const check = (box, obj, key, label) => {
    const row = document.createElement('label'); row.className = 'chk'; row.innerHTML = `<input type="checkbox"> ${label}`;
    const el = row.querySelector('input'); el.checked = !!obj[key]; el.addEventListener('change', () => { obj[key] = el.checked; onChange(key); });
    outs.push(() => { el.checked = !!obj[key]; }); box.appendChild(row); return el;
  };

  // the weather and the season
  // what is drawn (to look at the water alone), and the panel itself (H brings it back)
  const V = section('Show', true);
  check(V, state, 'trees', 'Trees'); check(V, state, 'grass', 'Grass');
  const hb = document.createElement('button'); hb.textContent = 'Hide the panel (H)'; hb.style.cssText = 'font: 11px system-ui; margin-top: 4px';
  hb.addEventListener('click', () => { hud.hidden = true; }); V.appendChild(hb);
  const W = section('Weather and season', true);
  check(W, state, 'auto', 'Weather follows the clock (day by day, its odds by the season)');
  slider(W, state, 'day', 'Day of year', 0, 359, 1, (v) => `${v | 0} ${seasonName(v)}`);
  slider(W, state, 'wind', 'Wind', 0, 20, 0.1, (v) => v.toFixed(1) + ' m/s');
  slider(W, state, 'rain', 'Rain', 0, 1, 0.01);
  slider(W, state, 'tideAmp', 'Tide (m)', 0, 3, 0.01, (v) => v.toFixed(2) + ' m'); slider(W, state, 'tideSpeed', 'Tide speed', 0, 600, 1, (v) => v ? `x${v} (${(12.42 * 60 / v).toFixed(1)} min)` : 'stopped');
  const kind = document.createElement('div'); kind.className = 'note'; kind.style.fontSize = '11px'; kind.style.opacity = '0.75'; W.appendChild(kind);
  outs.push(() => { kind.textContent = state.auto ? `today: ${state.kind || ''} · cover ${Math.round(state.cover * 100)}% · haze ${state.haze.toFixed(2)}` : 'the sliders hold the weather'; });

  // the water's look
  const L = state.look, B = section('Water');
  check(B, state, 'waterAuto', 'The weather and season move the water (rain: silt and murk; summer: algae; winter: clearer; wind: whitecaps)');
  const ps = document.createElement('div'); ps.className = 'seg';
  ps.innerHTML = Object.keys(GWATER_PRESETS).map((p) => `<button data-v="${p}"${p === L.preset ? ' class="on"' : ''}>${p}</button>`).join('');
  ps.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; for (const x of ps.querySelectorAll('button')) x.classList.toggle('on', x === b); L.preset = b.dataset.v; onChange('preset'); });
  B.appendChild(ps);
  const rows = [
    ['clarity', 'Clarity', 0.2, 4, 0.01], ['murk', 'Murk', 0, 6, 0.01], ['sediment', 'Silt', 0, 1.5, 0.01], ['stir', 'Surf stirs silt', 0, 2, 0.01], ['riverSilt', 'River silt', 0, 1.5, 0.01],
    ['roughness', 'Roughness', 0, 0.2, 0.001, (v) => v.toFixed(3)], ['refraction', 'Refraction', 0, 0.2, 0.001, (v) => v.toFixed(3)],
    ['sssPeak', 'Crest glow', 0, 6, 0.01], ['sssView', 'Glow to view', 0, 0.5, 0.001, (v) => v.toFixed(3)],
    ['foamBias', 'Whitecap bias', -0.5, 1.5, 0.01], ['foamScale', 'Whitecap scale', 0, 6, 0.01], ['linger', 'Foam linger', 0.2, 15, 0.1, (v) => v.toFixed(1) + ' s'],
    ['caustics', 'Caustics', 0, 3, 0.01],
    ['bubbles', 'Surf bubbles', 0, 3, 0.01], ['lip', 'Plunging lip', 0, 2, 0.01], ['spray', 'Spray amount', 0, 4, 0.01],
  ];
  for (const r of rows) slider(B, L, ...r);
  check(B, state, 'spray', 'Breakers\' spray');
  return { refresh() { for (const f of outs) f(); } };
}
