import { ITEMS, RARITY, type Collection, type Rarity } from '../game/drops';

const ORDER: Rarity[] = ['legendary', 'epic', 'rare', 'common'];

/** Full-screen view of everything you've collected, and what's still out there. */
export class CollectionScreen {
  readonly el: HTMLDivElement;
  visible = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'cnyc-coll';
    this.el.style.display = 'none';
    parent.appendChild(this.el);
    const style = document.createElement('style');
    style.textContent = `
      .cnyc-coll{position:absolute;inset:0;background:rgba(8,10,14,.9);backdrop-filter:blur(6px);color:#fff;z-index:4;overflow-y:auto;
        font-family:'Helvetica Neue',Arial,sans-serif;pointer-events:auto}
      .cnyc-coll .cc-wrap{max-width:1080px;margin:0 auto;padding:40px 28px 60px}
      .cnyc-coll header{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;border-bottom:1px solid rgba(255,255,255,.15);padding-bottom:18px}
      .cnyc-coll h1{margin:0;font-size:38px;letter-spacing:4px;font-weight:900}
      .cnyc-coll .cc-sub{font-size:13px;letter-spacing:2px;opacity:.7;margin-top:4px}
      .cnyc-coll .cc-stats{display:flex;gap:26px;text-align:right}
      .cnyc-coll .cc-stats b{display:block;font-size:30px;font-weight:800;color:#ffd23f;font-variant-numeric:tabular-nums}
      .cnyc-coll .cc-stats span{font-size:11px;letter-spacing:2px;opacity:.7}
      .cnyc-coll .cc-bar{height:6px;background:rgba(255,255,255,.12);border-radius:3px;margin-top:14px;overflow:hidden}
      .cnyc-coll .cc-bar i{display:block;height:100%;background:linear-gradient(90deg,#39c8ff,#c46bff,#ffb020)}
      .cnyc-coll h2{font-size:14px;letter-spacing:3px;margin:30px 0 12px;display:flex;align-items:center;gap:10px}
      .cnyc-coll h2 small{opacity:.6;font-weight:600}
      .cnyc-coll .cc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}
      .cnyc-coll .cc-card{position:relative;border-radius:10px;padding:16px 14px 14px;min-height:92px;background:rgba(255,255,255,.05);
        border:1px solid rgba(255,255,255,.12);display:flex;flex-direction:column;justify-content:space-between}
      .cnyc-coll .cc-card.cc-have{background:linear-gradient(160deg,var(--c-a),rgba(255,255,255,.03) 70%);border-color:var(--c)}
      .cnyc-coll .cc-card .cc-name{font-size:16px;font-weight:700;line-height:1.25}
      .cnyc-coll .cc-card.cc-lock .cc-name{opacity:.35;letter-spacing:3px}
      .cnyc-coll .cc-card .cc-meta{font-size:11px;letter-spacing:2px;margin-top:10px;opacity:.75;display:flex;justify-content:space-between}
      .cnyc-coll .cc-card .cc-count{position:absolute;top:10px;right:12px;font-size:13px;font-weight:800;color:var(--c)}
      .cnyc-coll .cc-gem{display:inline-block;width:10px;height:10px;transform:rotate(45deg);background:var(--c);box-shadow:0 0 10px var(--c)}
      .cnyc-coll footer{margin-top:34px;font-size:13px;opacity:.7;letter-spacing:1px}
      .cnyc-coll kbd{background:#fff;color:#111;border-radius:3px;padding:0 6px;font:700 13px/20px Helvetica,Arial}
      @media (max-width:600px){.cnyc-coll h1{font-size:28px}.cnyc-coll .cc-stats{text-align:left}}
    `;
    this.el.appendChild(style);
    this.el.appendChild(document.createElement('div')).className = 'cc-wrap';
  }

  open(c: Collection) {
    this.render(c);
    this.el.style.display = 'block';
    this.el.scrollTop = 0;
    this.visible = true;
  }

  close() {
    this.el.style.display = 'none';
    this.visible = false;
  }

  private render(c: Collection) {
    const all = ORDER.flatMap((r) => ITEMS[r]);
    const found = all.filter((n) => (c.items[n] ?? 0) > 0).length;
    const total = Object.values(c.counts).reduce((a, b) => a + b, 0);
    const hex = (h: string, a: number) => {
      const n = parseInt(h.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };
    const sections = ORDER.map((r) => {
      const info = RARITY[r];
      const items = ITEMS[r];
      const have = items.filter((n) => (c.items[n] ?? 0) > 0).length;
      const cards = items
        .map((n) => {
          const k = c.items[n] ?? 0;
          return k > 0
            ? `<div class="cc-card cc-have" style="--c:${info.color};--c-a:${hex(info.color, 0.22)}"><span class="cc-count">×${k}</span><div class="cc-name">${n}</div><div class="cc-meta"><span>${info.label}</span><span>+${info.points * k}</span></div></div>`
            : `<div class="cc-card cc-lock" style="--c:${info.color}"><div class="cc-name">? ? ?</div><div class="cc-meta"><span>${info.label}</span><span>NOT FOUND</span></div></div>`;
        })
        .join('');
      return `<h2 style="color:${info.color}"><span class="cc-gem" style="--c:${info.color}"></span>${info.label} <small>${have} / ${items.length}</small></h2><div class="cc-grid">${cards}</div>`;
    }).join('');
    (this.el.querySelector('.cc-wrap') as HTMLElement).innerHTML = `
      <header>
        <div><h1>COLLECTION</h1><div class="cc-sub">EVERYTHING YOU'VE PICKED UP ON THE STREETS OF MANHATTAN</div></div>
        <div class="cc-stats">
          <div><b>${c.points.toLocaleString('en-US')}</b><span>POINTS</span></div>
          <div><b>${found}/${all.length}</b><span>ITEMS FOUND</span></div>
          <div><b>${total}</b><span>DROPS</span></div>
        </div>
      </header>
      <div class="cc-bar"><i style="width:${Math.round((found / all.length) * 100)}%"></i></div>
      ${sections}
      <footer><kbd>I</kbd> or <kbd>Esc</kbd> back to the streets · the game is paused while this is open</footer>`;
  }
}
