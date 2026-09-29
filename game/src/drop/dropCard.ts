// From Ocean Drive (src/ui/dropCard.ts), shared with the Collect NYC garage.
// The card that comes up after a pull: tier, edition and serial, "This is your look" with the five traits,
// the six ratings, Performance Index and personality, the spec (game-tuned), "Verify this pull" with the
// bytes and the maths, and the live odds. DEMO data: the price is always "$99 (demo price)".
import {
  CHARACTER,
  classOf,
  DEMO_PRICE,
  PATTERN_NAMES,
  POOL_RANGES,
  RATING_KEYS,
  RATING_NAMES,
  TOTAL,
  type Car,
  type Pull,
  type Tier,
} from './drop01';

const CSS = `
#dropcard { position: fixed; right: 18px; top: 18px; width: 348px; max-height: calc(100vh - 36px); overflow-y: auto; z-index: 8;
  font: 12px/1.45 'Avenir Next', Avenir, 'Helvetica Neue', system-ui, sans-serif; color: #eef1f6; pointer-events: none;
  background: rgba(10, 12, 18, 0.82); backdrop-filter: blur(8px); border-radius: 10px; border-top: 3px solid var(--tc, #fff);
  box-shadow: 0 10px 40px rgba(0,0,0,0.35); padding: 14px 16px 12px; opacity: 0; transform: translateX(24px);
  transition: opacity 0.45s ease, transform 0.45s ease; scrollbar-width: none; }
#dropcard.on { opacity: 1; transform: none; }
#dropcard .demo { float: right; font-size: 10px; letter-spacing: 0.18em; border: 1px solid rgba(255,255,255,0.4); padding: 1px 6px; border-radius: 3px; opacity: 0.8; }
#dropcard .tier { font-size: 11px; letter-spacing: 0.24em; text-transform: uppercase; color: var(--tc); font-weight: 600; }
#dropcard h2 { margin: 4px 0 1px; font-size: 19px; font-weight: 600; letter-spacing: 0.02em; }
#dropcard .sub { opacity: 0.72; }
#dropcard h3 { margin: 12px 0 5px; font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; opacity: 0.6; font-weight: 600; }
#dropcard .row { display: flex; align-items: center; gap: 8px; margin: 2px 0; }
#dropcard .row .k { width: 64px; opacity: 0.6; }
#dropcard .row .v { flex: 1; }
#dropcard .sw { width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.3); flex: none; }
#dropcard .hex { opacity: 0.5; font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; }
#dropcard .bar { flex: 1; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; }
#dropcard .bar i { display: block; height: 100%; background: var(--tc); border-radius: 3px; width: 0; transition: width 0.9s cubic-bezier(.2,.8,.2,1); }
#dropcard .num { width: 26px; text-align: right; font-variant-numeric: tabular-nums; }
#dropcard .pi { display: flex; justify-content: space-between; margin-top: 6px; font-weight: 600; }
#dropcard .quote { font-style: italic; opacity: 0.85; margin-top: 4px; }
#dropcard .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px 10px; }
#dropcard .grid div span { opacity: 0.6; }
#dropcard .mono { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; word-break: break-all; opacity: 0.85; }
#dropcard .odds .row .k { width: 110px; }
#dropcard .note { margin-top: 10px; font-size: 10.5px; opacity: 0.55; }
#dropcard .keys { margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.12); font-size: 11px; opacity: 0.85; }
@media (max-width: 640px) { #dropcard { left: 10px; right: 10px; width: auto; top: auto; bottom: 10px; max-height: 46vh; } }
`;

const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const ed = (n: number) => `#${String(n).padStart(4, '0')}`;

export class DropCard {
  readonly el: HTMLDivElement;
  private wanted = false;

  constructor() {
    const css = document.createElement('style');
    css.textContent = CSS;
    document.head.appendChild(css);
    this.el = document.createElement('div');
    this.el.id = 'dropcard';
    document.body.appendChild(this.el);
  }

  get visible(): boolean {
    return this.wanted;
  }

  set(car: Car, p: Pull | null, odds: { tier: Tier; left: number; odds: number }[], left: number, keys?: string): void {
    const t = car.tier;
    const L = car.looks;
    const ch = CHARACTER[t.body];
    const pub = car.published;
    this.el.style.setProperty('--tc', t.color);
    const sw = (h: string) => `<span class="sw" style="background:${h}"></span>`;
    const paint = L.paint;
    const paintHex = paint.approx ? '' : paint.hex2 ? `${paint.hex} ${paint.kind === 'pearl' ? '→' : '/'} ${paint.hex2}` : paint.hex;
    const bars = RATING_KEYS.map(
      (k, i) => `<div class="row"><span class="k">${RATING_NAMES[k]}</span><span class="bar"><i data-w="${car.ratings[i]}"></i></span><span class="num">${car.ratings[i]}</span></div>`,
    ).join('');
    const s = car.spec;
    const spec = pub
      ? `<div>${fmt(pub.topSpeed, 1)} km/h <span>top</span></div><div>${fmt(pub.zeroTo100, 2)} s <span>0–100</span></div>
         <div>${pub.kw} kW <span>(${pub.hp} hp)</span></div><div>${pub.nm} Nm <span>torque</span></div>
         <div>${fmt(pub.mass)} kg <span>mass</span></div><div>${ch.drive} <span>${ch.gears} gears</span></div>`
      : `<div>≈ ${fmt(s.topSpeed, 1)} km/h <span>top</span></div><div>${fmt(s.wheelPower)} W/kg <span>at the wheels</span></div>
         <div>${fmt(s.launchGrip, 2)} g <span>launch</span></div><div>μ ${fmt(s.tyreGrip, 3)} <span>tyres</span></div>
         <div>${fmt(s.brakeEff, 2)} <span>brake eff.</span></div><div>${fmt(s.looseGrip, 2)} <span>loose grip</span></div>
         <div>${ch.drive} <span>${ch.gears} gears</span></div><div>~${fmt(ch.mass)} kg <span>mass</span></div>
         <div>${fmt(POOL_RANGES[t.body].zeroTo100[0], 2)}–${fmt(POOL_RANGES[t.body].zeroTo100[1], 2)} s <span>0–100 (body range)</span></div><div>${fmt(ch.redline)} <span>rpm redline</span></div>`;
    const verify = p
      ? `<div class="mono">${p.bytes.slice(0, 32)}<br>${p.bytes.slice(32)}</div>
         <div class="row"><span class="k">value</span><span class="v">mod ${fmt(p.poolSize)} = <b>${fmt(p.idx)}</b></span></div>
         <div class="row"><span class="k">pool[${p.idx}]</span><span class="v"><b>${ed(p.edition)}</b>${p.moved ? `, then ${ed(p.moved)} moves into slot ${p.idx}` : ' (the last slot)'}</span></div>`
      : `<div class="sub">From the lineup (not pulled here).</div>`;
    const oddsRows = odds
      .map((o) => `<div class="row"><span class="sw" style="background:${o.tier.color}"></span><span class="k">${o.tier.name}</span><span class="v">${fmt(o.left)} left</span><span class="num" style="width:44px">${fmt(o.odds * 100, 1)}%</span></div>`)
      .join('');
    this.el.innerHTML = `
      <span class="demo">DEMO</span>
      <div class="tier">${t.name}</div>
      <h2>Collect Car ${ed(car.edition)} · ${t.bodyName}</h2>
      <div class="sub">${car.serial} of ${t.count} · edition ${ed(car.edition)} of ${fmt(TOTAL)} · ${t.style}</div>
      <h3>This is your look</h3>
      <div class="row"><span class="k">Paint</span>${sw(paint.hex)}${paint.hex2 ? sw(paint.hex2) : ''}<span class="v">${paint.name} <span class="hex">${paintHex}</span></span></div>
      <div class="row"><span class="k">Pattern</span><span class="v">${PATTERN_NAMES[L.pattern]}</span></div>
      <div class="row"><span class="k">Finish</span><span class="v">${L.finish}</span></div>
      <div class="row"><span class="k">Light</span>${sw(L.lightHex)}<span class="v">${L.light} <span class="hex">${L.lightHex}</span></span></div>
      <div class="row"><span class="k">Wheels</span><span class="v">${L.wheels}</span></div>
      <h3>Ratings</h3>
      ${bars}
      <div class="pi"><span>Performance Index ${car.pi} · ${classOf(car.pi)}</span><span>budget ${t.budget}${t.bonus ? ` (+${t.bonus}%)` : ''}</span></div>
      <div class="quote">“${car.personality}”</div>
      <h3>Spec <span style="text-transform:none;letter-spacing:0">(game-tuned${pub ? ', published edition' : ''})</span></h3>
      <div class="grid">${spec}</div>
      <h3>Verify this pull</h3>
      ${verify}
      <h3>Live odds · ${fmt(left)} of ${fmt(TOTAL)} left</h3>
      <div class="odds">${oddsRows}</div>
      <div class="note">Every body starts from the same Performance Index and leads its own discipline (${t.bodyName}: ${ch.leads}); rarity adds a small bonus, capped at 3% of the rating budget.${pub ? '' : ' Ratings: tuning re-implemented from the spec rules (the drop generator itself isn’t in this demo).'} Looks derived from the DEMO seed.</div>
      <div class="keys">${keys ?? `E&nbsp; pull again · ${DEMO_PRICE}`}</div>`;
    // animate the rating bars in
    setTimeout(() => this.el.querySelectorAll<HTMLElement>('.bar i').forEach((b) => (b.style.width = `${b.dataset.w}%`)), 40);
  }

  show(on: boolean): void {
    this.wanted = on;
    this.el.classList.toggle('on', on);
  }
}
