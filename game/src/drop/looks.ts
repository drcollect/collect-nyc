import type { LiveryChoice, StripeStyle } from '../car/specs';
import { stripeColorFor } from '../car/specs';
import type { Car as DropCar, PatternId } from './drop01';

// How a Drop 01 edition's look is worn by the game's car models. The body is the tier's (the five Collect
// cars are the five drop bodies). The game paints with a colour, a neon accent and one stripe layout, so
// the drop's graphic patterns are approximated by the nearest stripe layout.

const STRIPE_OF: Record<PatternId, StripeStyle> = {
  none: 'none',
  split: 'center',
  twin: 'twin',
  monogram: 'center',
  circuit: 'twin',
  hex: 'twin',
  topo: 'side',
  glitch: 'side',
};

export function carIdOf(car: DropCar): string {
  return car.tier.body; // rally, wedge, endurance, hypercar, streamliner: the game's car ids
}

export function liveryOf(car: DropCar): LiveryChoice {
  const L = car.looks;
  const color = L.paint.hex;
  const accent = L.lightHex;
  let stripe = STRIPE_OF[L.pattern];
  let stripeColor: string;
  if (L.paint.kind === 'twotone' && L.paint.hex2) {
    // two-tone: the lower colour as a full side band
    stripe = 'side';
    stripeColor = L.paint.hex2;
  } else if ((L.paint.kind === 'pearl' || L.paint.kind === 'special') && L.paint.hex2) {
    stripeColor = L.paint.hex2;
  } else {
    stripeColor = stripeColorFor(color, accent, stripe);
  }
  return { color, accent, stripe, stripeColor };
}
