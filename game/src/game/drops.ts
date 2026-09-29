import * as THREE from 'three';
import type { StreetGraph } from '../city/graph';
import { Beacon } from './markers';

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';

export const RARITY: Record<Rarity, { color: string; points: number; life: number; weight: number; label: string }> = {
  common: { color: '#39c8ff', points: 100, life: 240, weight: 60, label: 'COMMON' },
  rare: { color: '#7dff5a', points: 250, life: 180, weight: 27, label: 'RARE' },
  epic: { color: '#c46bff', points: 600, life: 130, weight: 10, label: 'EPIC' },
  legendary: { color: '#ffb020', points: 1500, life: 95, weight: 3, label: 'LEGENDARY' },
};

/** What a drop turns out to be. Kept to car culture and New York. */
export const ITEMS: Record<Rarity, string[]> = {
  common: ['Chrome Valve Caps', 'NYC Plate Frame', 'Racing Decal Pack', 'Steering Wheel Wrap', 'Air Freshener: Hot Dog', 'Tyre Shine', 'Pinstripe Kit', 'Subway Token Keyring'],
  rare: ['Carbon Mirror Caps', 'Neon Underglow', 'Forged Wheel Set', 'Yellow Cab Livery', 'Bodega Cat Bobblehead', 'Brownstone Red Paint'],
  epic: ['Liberty Green Paint', 'Chrysler Deco Grille', 'Titanium Exhaust', 'Night-Shift Tint'],
  legendary: ['Empire Gold Livery', 'Midnight Chrome Wrap', 'Original 1:1 Blueprint'],
};

export interface Drop {
  id: number;
  rarity: Rarity;
  item: string;
  x: number;
  z: number;
  born: number;
  life: number;
  beacon: Beacon;
}

export interface Collection {
  points: number;
  items: Record<string, number>;
  counts: Record<Rarity, number>;
}

const KEY = 'cnyc.collection.v1';

export function loadCollection(): Collection {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (c && typeof c.points === 'number') return c;
  } catch {
    /* ignore */
  }
  return { points: 0, items: {}, counts: { common: 0, rare: 0, epic: 0, legendary: 0 } };
}

function saveCollection(c: Collection) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

const ACTIVE = 5;
const PICKUP_R = 6.5;

/**
 * Timed drops around the island. A few are live at once; each has a clock, and when it runs out a rival
 * crew grabs it. Drive through one to collect it.
 */
export class Drops {
  readonly group = new THREE.Group();
  readonly list: Drop[] = [];
  collection = loadCollection();
  onCollect: ((d: Drop) => void) | null = null;
  onLost: ((d: Drop) => void) | null = null;
  onClaimed: ((d: Drop, by: string) => void) | null = null;
  /** any drop leaving the map (collected, claimed or expired) */
  onTaken: ((d: Drop) => void) | null = null;
  private nextId = 1;
  private spawnCooldown = 0;
  private rand = Math.random;
  enabled = true;

  constructor(private graph: StreetGraph) {
    this.group.name = 'Drops';
  }

  private pickRarity(): Rarity {
    const total = Object.values(RARITY).reduce((s, r) => s + r.weight, 0);
    let x = this.rand() * total;
    for (const k of Object.keys(RARITY) as Rarity[]) {
      x -= RARITY[k].weight;
      if (x <= 0) return k;
    }
    return 'common';
  }

  private spawn(now: number, near: THREE.Vector3) {
    const rarity = this.pickRarity();
    // better drops land further away
    const ring = { common: [250, 1400], rare: [500, 2000], epic: [800, 2600], legendary: [1200, 3200] }[rarity];
    const node = this.graph.randomNode(this.rand, { x: near.x, z: near.z, min: ring[0], max: ring[1] }, (e) => e.c !== 'motorway' && e.c !== 'trunk');
    const x = this.graph.x(node), z = this.graph.z(node);
    if (this.list.some((d) => Math.hypot(d.x - x, d.z - z) < 200)) return;
    const info = RARITY[rarity];
    const items = ITEMS[rarity];
    const beacon = new Beacon(info.color, rarity === 'legendary' ? 420 : 300, rarity === 'legendary' ? 3.2 : 2.2);
    beacon.group.position.set(x, 0, z);
    this.group.add(beacon.group);
    this.list.push({ id: this.nextId++, rarity, item: items[Math.floor(this.rand() * items.length)], x, z, born: now, life: info.life, beacon });
  }

  timeLeft(d: Drop, now: number) {
    return Math.max(0, d.born + d.life - now);
  }

  /** the drop worth heading for: best value per metre, among those you can still reach in time */
  target(pos: THREE.Vector3, now: number): Drop | null {
    let best: Drop | null = null, score = -1;
    for (const d of this.list) {
      const dist = Math.hypot(d.x - pos.x, d.z - pos.z);
      const s = RARITY[d.rarity].points / (dist + 150);
      if (dist / 30 > this.timeLeft(d, now) + 10) continue; // hopeless even at ~65 mph
      if (s > score) {
        score = s;
        best = d;
      }
    }
    return best;
  }

  update(dt: number, now: number, pos: THREE.Vector3) {
    this.group.visible = this.enabled;
    if (!this.enabled) return;
    this.spawnCooldown -= dt;
    if (this.list.length < ACTIVE && this.spawnCooldown <= 0) {
      this.spawn(now, pos);
      this.spawnCooldown = this.list.length < 2 ? 0.2 : 6;
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const d = this.list[i];
      const left = this.timeLeft(d, now);
      d.beacon.update(dt, left < 20 ? 1 : 0);
      if (Math.hypot(d.x - pos.x, d.z - pos.z) < PICKUP_R && pos.y < 4) {
        this.remove(i);
        const c = this.collection;
        c.points += RARITY[d.rarity].points;
        c.counts[d.rarity] = (c.counts[d.rarity] ?? 0) + 1;
        c.items[d.item] = (c.items[d.item] ?? 0) + 1;
        saveCollection(c);
        this.onCollect?.(d);
      } else if (left <= 0) {
        this.remove(i);
        this.onLost?.(d);
      }
    }
  }

  /** a rival got there first */
  claim(d: Drop, by: string) {
    const i = this.list.indexOf(d);
    if (i < 0) return;
    this.remove(i);
    this.onClaimed?.(d, by);
  }

  private remove(i: number) {
    const d = this.list[i];
    this.group.remove(d.beacon.group);
    d.beacon.dispose();
    this.list.splice(i, 1);
    this.onTaken?.(d);
  }
}
