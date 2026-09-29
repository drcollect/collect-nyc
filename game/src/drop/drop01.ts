// Collect Car · Drop 01, as its design describes it: 1,000 cars in five tiers,
// one body per tier, derived from the DEMO seed with SHA-256; a pull takes 32 random bytes, reads them as
// one big-endian number, and the number mod the cars left picks the edition (swap-remove). Tiers and looks
// follow the spec's procedure and tables exactly. The per-car tuning follows the spec's rules (triangle
// nudges of ±6, scaled to the tier budget, 35–99, unique per body) but the drop's own generator isn't
// available here, so tuned ratings are a re-implementation; the five editions the spec publishes carry
// their published numbers. Everything is DEMO data; physical numbers are game-tuned.
import { be, bigOf, concat, first8, hex, sha256, utf8 } from './sha256';

export type TierId = 'common' | 'uncommon' | 'rare' | 'ultra' | 'secret';
export type Body = 'rally' | 'wedge' | 'endurance' | 'hypercar' | 'streamliner';

export interface Tier {
  id: TierId;
  name: string;
  body: Body;
  bodyName: string;
  count: number;
  /** % added to the rating budget */
  bonus: number;
  budget: number;
  color: string;
  /** the look family */
  style: string;
}

export const TIERS: Tier[] = [
  { id: 'common', name: 'Common', body: 'rally', bodyName: 'Rally', count: 600, bonus: 0, budget: 400, color: '#A7B0BE', style: 'solid paints' },
  { id: 'uncommon', name: 'Uncommon', body: 'wedge', bodyName: 'Wedge', count: 225, bonus: 0.75, budget: 403, color: '#3DDC84', style: 'metallics' },
  { id: 'rare', name: 'Rare', body: 'endurance', bodyName: 'Endurance', count: 100, bonus: 1.5, budget: 406, color: '#3B82F6', style: 'pearlescents that shift colour' },
  { id: 'ultra', name: 'Ultra Rare', body: 'hypercar', bodyName: 'Hypercar', count: 50, bonus: 2.25, budget: 409, color: '#A855F7', style: 'two-tones with chrome trim' },
  { id: 'secret', name: 'Secret Rare', body: 'streamliner', bodyName: 'Streamliner', count: 25, bonus: 3, budget: 412, color: '#F5B83D', style: 'iridescent liquid-metal specials' },
];
export const tierById = (id: TierId) => TIERS.find((t) => t.id === id)!;

export const TOTAL = 1000;
export const DEMO_PRICE = '$99 (demo price)';
export const SEED_TEXT = 'collect-car-drop-demo-seed-v2';
export const SEED = sha256(utf8(SEED_TEXT));
export const SEED_HEX = hex(SEED);
export const PROVENANCE_DEMO = '40630a003b59cab82e6d011fef55c977d4d8141b7c157346181b3476fd2c60eb';

// ---------------------------------------------------------------- looks tables (weights in table order)

export interface Paint {
  name: string;
  /** solid/metallic: the colour; pearl: base; two-tone: upper; special: base */
  hex: string;
  /** pearl: shift; two-tone: lower; special: flip */
  hex2?: string;
  kind: 'solid' | 'metallic' | 'pearl' | 'twotone' | 'special';
  /** true where the spec gives no hex and the render uses an approximation */
  approx?: boolean;
}
type Row<T> = [T, number];

// the two-tones are named in the spec without hexes: these are render approximations
const TT = (upper: string, lower: string, hu: string, hl: string): Paint => ({ name: `${upper} / ${lower}`, hex: hu, hex2: hl, kind: 'twotone', approx: true });

export const PAINTS: Record<TierId, Row<Paint>[]> = {
  common: ([
    ['Graphite', '#2B2F36', 10], ['Porcelain', '#E9ECEF', 10], ['Signal Red', '#D2381C', 9], ['Cobalt', '#1F4FD1', 9],
    ['Rally Orange', '#E8671B', 8], ['Racing Green', '#0F5C3A', 8], ['Sand', '#C9B48A', 7], ['Ice Blue', '#A9D8F0', 7],
    ['Solar Yellow', '#F2C230', 6], ['Slate', '#56606B', 6], ['Olive Drab', '#5E6B3A', 5], ['Brick', '#8E3B2E', 5],
    ['Arctic White', '#F7F8FA', 4], ['Jet Black', '#111316', 4], ['Teal', '#13847E', 3], ['Lilac', '#B39DDB', 3],
  ] as [string, string, number][]).map(([name, h, w]) => [{ name, hex: h, kind: 'solid' }, w]),
  uncommon: ([
    ['Gunmetal', '#4A4F57', 14], ['Liquid Silver', '#B8BEC6', 13], ['Midnight Blue', '#1A2346', 12], ['Crimson', '#8E1020', 11],
    ['Emerald', '#0E6B4F', 10], ['Bronze', '#8C5A2B', 10], ['Electric Blue', '#1E5BFF', 9], ['Copper', '#B06A3B', 8],
    ['Plum', '#5B2A5E', 7], ['Blaze', '#D9651E', 6],
  ] as [string, string, number][]).map(([name, h, w]) => [{ name, hex: h, kind: 'metallic' }, w]),
  rare: ([
    ['Pearl White', '#F3EFE6', '#D8E6FF', 15], ['Opal Blue', '#9CC3E6', '#E3D1FF', 14], ['Rose Pearl', '#E7B8C2', '#FFE7C2', 13],
    ['Jade Pearl', '#7FBFA6', '#D9F2E6', 13], ['Moonstone', '#C9CDD6', '#BFD9FF', 12], ['Tanzanite', '#4B3F9E', '#3FA0C9', 12],
    ['Amber Pearl', '#D8963A', '#F2D16B', 11], ['Onyx Pearl', '#22252B', '#5A3F8C', 10],
  ] as [string, string, string, number][]).map(([name, h, h2, w]) => [{ name, hex: h, hex2: h2, kind: 'pearl' }, w]),
  ultra: [
    [TT('Obsidian', 'Steel', '#15171B', '#7D8791'), 18],
    [TT('Ivory', 'Carbon', '#EFE9DA', '#1B1C1F'), 17],
    [TT('Scarlet', 'Carbon', '#C8121C', '#1B1C1F'), 17],
    [TT('Azure', 'Graphite', '#1E7FE0', '#2B2F36'), 16],
    [TT('Ember', 'Black', '#E0531A', '#0E0F11'), 16],
    [TT('Glacier', 'Gunmetal', '#D2E7F2', '#4A4F57'), 16],
  ],
  secret: ([
    ['Liquid Mercury', '#C9CED6', '#8FA3FF'], ['Oil Slick', '#1E1B2E', '#3FE0C5'], ['Aurora Chrome', '#A8F0E0', '#C77DFF'],
    ['Solar Flare', '#FF7A18', '#FFD23F'], ['Nebula', '#3A1C71', '#FF4FD8'],
  ] as [string, string, string][]).map(([name, h, h2]) => [{ name, hex: h, hex2: h2, kind: 'special' }, 20]),
};

export type PatternId = 'none' | 'split' | 'twin' | 'circuit' | 'topo' | 'hex' | 'glitch' | 'monogram';
export const PATTERN_NAMES: Record<PatternId, string> = {
  none: 'None', split: 'Split', twin: 'Twin Stripe', circuit: 'Circuit', topo: 'Topographic', hex: 'Hex', glitch: 'Glitch', monogram: 'Monogram',
};
export const PATTERNS: Record<TierId, Row<PatternId>[]> = {
  common: [['none', 30], ['twin', 24], ['split', 20], ['hex', 14], ['topo', 12]],
  uncommon: [['none', 22], ['twin', 20], ['split', 18], ['hex', 15], ['topo', 14], ['circuit', 11]],
  rare: [['twin', 20], ['split', 18], ['hex', 17], ['topo', 17], ['circuit', 16], ['glitch', 12]],
  ultra: [['split', 20], ['hex', 18], ['topo', 17], ['circuit', 17], ['glitch', 16], ['monogram', 12]],
  secret: [['none', 20], ['topo', 20], ['circuit', 20], ['glitch', 20], ['monogram', 20]],
};

export type FinishId =
  | 'Gloss' | 'Satin' | 'Matte' | 'Metallic' | 'Satin Metallic' | 'Brushed' | 'Pearl Gloss' | 'Pearl Satin'
  | 'Chrome Trim' | 'Black Chrome Trim' | 'Gold Chrome Trim' | 'Liquid Metal' | 'Prism Flake';
export const FINISHES: Record<TierId, Row<FinishId>[]> = {
  common: [['Gloss', 50], ['Satin', 32], ['Matte', 18]],
  uncommon: [['Metallic', 50], ['Satin Metallic', 30], ['Brushed', 20]],
  rare: [['Pearl Gloss', 60], ['Pearl Satin', 40]],
  ultra: [['Chrome Trim', 40], ['Black Chrome Trim', 32], ['Gold Chrome Trim', 28]],
  secret: [['Liquid Metal', 50], ['Prism Flake', 50]],
};

export const LIGHT_HEX: Record<string, string> = {
  White: '#F4F7FF', 'Warm White': '#FFE2B8', Amber: '#FFB020', Ice: '#BFE8FF', Red: '#FF2A2A', Lime: '#9CFF3A', Cyan: '#22E6FF',
  Magenta: '#FF2BD6', Violet: '#8A5CFF', Gold: '#FFD34D', Ultraviolet: '#7A3BFF', 'Solar Gold': '#FFC940', Aurora: '#3BFFC1',
};
export const LIGHTS: Record<TierId, Row<string>[]> = {
  common: [['White', 30], ['Warm White', 22], ['Amber', 18], ['Ice', 14], ['Red', 9], ['Lime', 7]],
  uncommon: [['White', 24], ['Ice', 20], ['Cyan', 18], ['Amber', 16], ['Red', 12], ['Lime', 10]],
  rare: [['White', 20], ['Ice', 18], ['Cyan', 18], ['Magenta', 16], ['Violet', 16], ['Amber', 12]],
  ultra: [['Cyan', 28], ['Magenta', 26], ['Violet', 24], ['Gold', 22]],
  secret: [['Ultraviolet', 34], ['Solar Gold', 33], ['Aurora', 33]],
};

export type WheelId =
  | 'Gloss Black' | 'Satin Black' | 'Silver' | 'Gunmetal' | 'White' | 'Bronze' | 'Anodised Red' | 'Anodised Blue'
  | 'Body Colour' | 'Chrome' | 'Black Chrome' | 'Gold' | 'Iridescent';
export const WHEELS: Record<TierId, Row<WheelId>[]> = {
  common: [['Gloss Black', 25], ['Satin Black', 25], ['Silver', 20], ['Gunmetal', 15], ['White', 15]],
  // the spec lists these by weight; #0001 (Body Colour) places Body Colour last in the generator's order
  uncommon: [['Gunmetal', 25], ['Silver', 20], ['Bronze', 20], ['Satin Black', 15], ['Body Colour', 20]],
  rare: [['Bronze', 20], ['Body Colour', 20], ['Anodised Red', 15], ['Anodised Blue', 15], ['White', 15], ['Gunmetal', 15]],
  ultra: [['Chrome', 30], ['Black Chrome', 30], ['Gold', 25], ['Body Colour', 15]],
  secret: [['Iridescent', 40], ['Gold', 30], ['Chrome', 30]],
};

// ---------------------------------------------------------------- performance tables

export const RATING_KEYS = ['speed', 'accel', 'launch', 'handling', 'braking', 'offroad'] as const;
export type RatingKey = (typeof RATING_KEYS)[number];
export const RATING_NAMES: Record<RatingKey, string> = { speed: 'Speed', accel: 'Acceleration', launch: 'Launch', handling: 'Handling', braking: 'Braking', offroad: 'Off-road' };
export const BASE: Record<Body, number[]> = {
  rally: [55, 66, 76, 64, 59, 80],
  wedge: [58, 60, 64, 86, 76, 56],
  endurance: [72, 61, 60, 73, 88, 46],
  hypercar: [62, 74, 89, 52, 72, 51],
  streamliner: [86, 53, 64, 60, 85, 52],
};
const PI_WEIGHTS = [20, 20, 15, 18, 12, 15];
const LEAD: Record<RatingKey, string> = {
  speed: 'Long-legged and happiest flat out',
  accel: 'Punchy, pulls hard out of every corner',
  launch: 'Explosive off the line',
  handling: 'Darty nose, changes direction in a blink',
  braking: 'Brakes impossibly late',
  offroad: 'Shrugs off gravel and ruts',
};
/** handling balance of each body (−1 oversteer … +1 understeer) and the phrase that goes with it */
export const BALANCE: Record<Body, { value: number; phrase: string }> = {
  rally: { value: -0.1, phrase: 'neutral and honest at the limit' },
  wedge: { value: -0.35, phrase: 'rotates eagerly on the throttle' },
  endurance: { value: 0.3, phrase: 'planted and predictable' },
  hypercar: { value: 0.12, phrase: 'planted and predictable' },
  streamliner: { value: 0.35, phrase: 'nose-heavy, safe at the limit' },
};
export const CHARACTER: Record<Body, { drive: string; mass: number; gears: number; redline: number; leads: string; archetype: string }> = {
  rally: { drive: 'AWD', mass: 1320, gears: 6, redline: 7800, leads: 'loose surfaces', archetype: 'off-road, launch and all-wheel drive' },
  wedge: { drive: 'RWD', mass: 1080, gears: 7, redline: 9000, leads: 'tyre grip', archetype: 'a nimble rear-drive wedge, handling first' },
  endurance: { drive: 'RWD', mass: 1050, gears: 6, redline: 9400, leads: 'braking', archetype: 'high-speed stability and the biggest brakes' },
  hypercar: { drive: 'AWD', mass: 1400, gears: 8, redline: 8800, leads: '0–100', archetype: 'all-wheel-drive power, acceleration and launch' },
  streamliner: { drive: 'RWD', mass: 1280, gears: 7, redline: 8400, leads: 'top speed', archetype: 'top speed first' },
};
/** spec ranges in the demo pool (0–100 s, power kW, mass kg) */
export const POOL_RANGES: Record<Body, { zeroTo100: [number, number]; kw: [number, number]; mass: [number, number] }> = {
  rally: { zeroTo100: [3.07, 3.44], kw: [283, 341], mass: [1295, 1349] },
  wedge: { zeroTo100: [3.28, 3.68], kw: [213, 257], mass: [1059, 1097] },
  endurance: { zeroTo100: [3.2, 3.45], kw: [244, 280], mass: [1031, 1063] },
  hypercar: { zeroTo100: [2.69, 2.91], kw: [373, 428], mass: [1370, 1418] },
  streamliner: { zeroTo100: [3.16, 3.34], kw: [300, 336], mass: [1263, 1293] },
};

/** the five editions the spec publishes, with their published numbers */
interface Published {
  ratings: number[];
  pi: number;
  topSpeed: number;
  zeroTo100: number;
  kw: number;
  hp: number;
  nm: number;
  mass: number;
  personality: string;
}
export const PUBLISHED: Record<number, Published> = {
  4: { ratings: [55, 62, 77, 62, 63, 81], pi: 728, topSpeed: 268, zeroTo100: 3.34, kw: 299, hp: 401, nm: 595, mass: 1334, personality: 'Brakes impossibly late; neutral and honest at the limit' },
  1: { ratings: [57, 58, 64, 90, 83, 51], pi: 734, topSpeed: 274.7, zeroTo100: 3.58, kw: 221, hp: 296, nm: 319, mass: 1071, personality: 'Brakes impossibly late; rotates eagerly on the throttle' },
  3: { ratings: [69, 62, 64, 77, 91, 43], pi: 740, topSpeed: 315.4, zeroTo100: 3.29, kw: 251, hp: 337, nm: 366, mass: 1039, personality: 'Explosive off the line; planted and predictable' },
  20: { ratings: [64, 79, 87, 57, 76, 46], pi: 749, topSpeed: 298.5, zeroTo100: 2.76, kw: 409, hp: 548, nm: 727, mass: 1370, personality: 'Darty nose, changes direction in a blink; planted and predictable' },
  32: { ratings: [89, 50, 70, 60, 88, 55], pi: 749, topSpeed: 383.7, zeroTo100: 3.22, kw: 308, hp: 413, nm: 523, mass: 1293, personality: 'Explosive off the line; nose-heavy, safe at the limit' },
};

// ---------------------------------------------------------------- derivation

/** category names hashed into each draw (these reproduce all five published editions' looks) */
export const CATEGORY = { paint: 'paint', pattern: 'pattern', finish: 'finish', light: 'light', wheels: 'wheel' };

function drawIndex(edition: number, attempt: number, category: string, weights: number[]): number {
  const h = sha256(concat(SEED, be(edition, 2), be(attempt, 1), utf8(category)));
  const total = weights.reduce((a, b) => a + b, 0);
  const r = Number(first8(h) % BigInt(total));
  let run = 0;
  for (let i = 0; i < weights.length; i++) {
    run += weights[i];
    if (run > r) return i;
  }
  return weights.length - 1;
}
const pick = <T>(edition: number, attempt: number, category: string, rows: Row<T>[]): T => rows[drawIndex(edition, attempt, category, rows.map((r) => r[1]))][0];

/** Fisher–Yates over the fixed list, driven by SHA-256(seed || "tiers" || uint32(i)). */
function shuffleTiers(): TierId[] {
  const list: TierId[] = [];
  for (const t of TIERS) for (let i = 0; i < t.count; i++) list.push(t.id);
  const tag = utf8('tiers');
  for (let i = TOTAL - 1; i >= 1; i--) {
    const h = sha256(concat(SEED, tag, be(i, 4)));
    const j = Number(first8(h) % BigInt(i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

export interface Looks {
  paint: Paint;
  pattern: PatternId;
  finish: FinishId;
  light: string;
  lightHex: string;
  wheels: WheelId;
  attempt: number;
}

export interface Spec {
  topSpeed: number;
  wheelPower: number;
  launchGrip: number;
  tyreGrip: number;
  downforce: number;
  brakeEff: number;
  looseGrip: number;
  rolling: number;
  shift: number;
}

export interface Car {
  edition: number;
  tier: Tier;
  /** "12 of 50" */
  serial: number;
  looks: Looks;
  ratings: number[];
  tuneAttempt: number;
  pi: number;
  personality: string;
  spec: Spec;
  /** the spec publishes this edition (exact numbers) */
  published?: Published;
}

const TRIANGLE: Row<number>[] = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].map((n) => [n, 7 - Math.abs(n)]);

/** Scale to the budget with largest-remainder rounding, then keep every rating within 35–99. */
function toBudget(raw: number[], budget: number): number[] {
  const sum = raw.reduce((a, b) => a + b, 0);
  const exact = raw.map((v) => (v * budget) / sum);
  const out = exact.map(Math.floor);
  let left = budget - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % out.length, left--) out[order[k][1]]++;
  for (let i = 0; i < out.length; i++) out[i] = Math.min(99, Math.max(35, out[i]));
  return out;
}

export function piOf(r: number[]): number {
  return 70 + Math.round(r.reduce((a, v, i) => a + v * PI_WEIGHTS[i], 0) / 10);
}
export const classOf = (pi: number) => (pi <= 400 ? 'D' : pi <= 500 ? 'C' : pi <= 600 ? 'B' : pi <= 700 ? 'A' : pi <= 800 ? 'S1' : pi <= 900 ? 'S2' : 'X');

export function specOf(r: number[]): Spec {
  const [s, a, l, h, b, o] = r;
  return {
    topSpeed: 200 + 3.4 * (s - 35),
    wheelPower: 80 + 2.9 * (a - 35) + 1.6 * (s - 35),
    launchGrip: 0.78 + 0.009 * (l - 35),
    tyreGrip: 1 + 0.0045 * (h - 35) + 0.0015 * (l - 35) + 0.001 * (b - 35),
    downforce: 0.5 + 0.18 * (h - 35) + 0.06 * (b - 35),
    brakeEff: 0.35 + 0.0065 * b,
    looseGrip: 0.34 + 0.0066 * o,
    rolling: 0.009 + 0.00006 * (o - 35),
    shift: 0.09 - 0.0006 * (a - 35),
  };
}

function personalityOf(body: Body, r: number[], budget: number): string {
  // the lead phrase: the rating that gained most over the body's base split (scaled to the budget)
  const base = BASE[body];
  let best = 0;
  let bestGain = -Infinity;
  r.forEach((v, i) => {
    const gain = v - (base[i] * budget) / 400;
    if (gain > bestGain) {
      bestGain = gain;
      best = i;
    }
  });
  return `${LEAD[RATING_KEYS[best]]}; ${BALANCE[body].phrase}`;
}

/** The whole pool, derived once. */
export function derivePool(): Car[] {
  const tiers = shuffleTiers();
  const serials: Record<TierId, number> = { common: 0, uncommon: 0, rare: 0, ultra: 0, secret: 0 };
  const seenLooks = new Set<string>();
  const seenTune = new Set<string>();
  const cars: Car[] = [];
  for (let edition = 1; edition <= TOTAL; edition++) {
    const tier = tierById(tiers[edition - 1]);
    const t = tier.id;
    // looks: paint, pattern, finish, light unique per body; redraw all four with attempt + 1 on a repeat
    let attempt = 0;
    let looks: Omit<Looks, 'wheels' | 'attempt'>;
    for (;;) {
      const paint = pick(edition, attempt, CATEGORY.paint, PAINTS[t]);
      const pattern = pick(edition, attempt, CATEGORY.pattern, PATTERNS[t]);
      const finish = pick(edition, attempt, CATEGORY.finish, FINISHES[t]);
      const light = pick(edition, attempt, CATEGORY.light, LIGHTS[t]);
      const key = `${tier.body}|${paint.name}|${pattern}|${finish}|${light}`;
      if (!seenLooks.has(key)) {
        seenLooks.add(key);
        looks = { paint, pattern, finish, light, lightHex: LIGHT_HEX[light] };
        break;
      }
      attempt++;
    }
    const wheels = pick(edition, 0, CATEGORY.wheels, WHEELS[t]);
    // tuning: triangle nudges, scaled to the tier budget, unique per body
    let tuneAttempt = 0;
    let ratings: number[];
    for (;;) {
      const raw = BASE[tier.body].map((v, i) => v + pick(edition, tuneAttempt, `tune:${RATING_KEYS[i]}`, TRIANGLE));
      ratings = toBudget(raw, tier.budget);
      const key = `${tier.body}|${ratings.join(',')}`;
      if (!seenTune.has(key)) {
        seenTune.add(key);
        break;
      }
      tuneAttempt++;
    }
    const published = PUBLISHED[edition];
    if (published) ratings = published.ratings.slice();
    cars.push({
      edition,
      tier,
      serial: ++serials[t],
      looks: { ...looks!, wheels, attempt },
      ratings,
      tuneAttempt,
      pi: published?.pi ?? piOf(ratings),
      personality: published?.personality ?? personalityOf(tier.body, ratings, tier.budget),
      spec: specOf(ratings),
      published,
    });
  }
  return cars;
}

let cache: Car[] | null = null;
/** the pool, derived once per page */
export function dropPool(): Car[] {
  return (cache ??= derivePool());
}

// ---------------------------------------------------------------- the pull

export interface Pull {
  edition: number;
  /** 32 random bytes, hex */
  bytes: string;
  /** cars left before this pull */
  poolSize: number;
  /** the bytes as a big-endian number mod poolSize */
  idx: number;
  /** the edition that moved into the slot (swap-remove) */
  moved: number | null;
  at: number;
}

export interface DropState {
  pool: number[];
  pulls: Pull[];
}

export const freshState = (): DropState => ({ pool: Array.from({ length: TOTAL }, (_, i) => i + 1), pulls: [] });

/** One pull: the bytes, mod the cars left, swap-remove. Returns null when the drop has sold out. */
export function pull(state: DropState, bytes: Uint8Array): Pull | null {
  const n = state.pool.length;
  if (n === 0) return null;
  const idx = Number(bigOf(bytes) % BigInt(n));
  const edition = state.pool[idx];
  const last = state.pool[n - 1];
  state.pool[idx] = last;
  state.pool.pop();
  const p: Pull = { edition, bytes: hex(bytes), poolSize: n, idx, moved: idx === n - 1 ? null : last, at: Date.now() };
  state.pulls.push(p);
  return p;
}

/** Cars left per tier and the odds of the next pull. */
export function liveOdds(state: DropState, cars: Car[]): { tier: Tier; left: number; odds: number }[] {
  const left: Record<TierId, number> = { common: 0, uncommon: 0, rare: 0, ultra: 0, secret: 0 };
  for (const e of state.pool) left[cars[e - 1].tier.id]++;
  const n = Math.max(1, state.pool.length);
  return TIERS.map((tier) => ({ tier, left: left[tier.id], odds: left[tier.id] / n }));
}

const KEY = 'cnyc.drop01.v1';
export function loadState(): DropState {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s && Array.isArray(s.pool) && Array.isArray(s.pulls)) return s;
  } catch {
    /* private mode, blocked storage */
  }
  return freshState();
}
export function saveState(s: DropState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
