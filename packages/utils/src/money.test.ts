import { describe, expect, it } from 'vitest';
import {
  addMoney,
  allocateRefundLine,
  applyBasisPoints,
  discountPercent,
  formatMoney,
  money,
  MoneyError,
  parseDecimalToMinor,
  refundedFeeAt,
  subtractMoney,
  toDecimalString,
} from './money.js';

describe('money', () => {
  it('rejects non-integer minor units', () => {
    expect(() => money(10.5, 'EUR')).toThrow(MoneyError);
  });

  it('refuses to mix currencies', () => {
    expect(() => addMoney(money(1000, 'EUR'), money(1000, 'USD'))).toThrow(MoneyError);
  });

  it('adds and subtracts exactly where floats would drift', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; in minor units it is exact.
    const total = addMoney(money(10, 'EUR'), money(20, 'EUR'));
    expect(total.amount).toBe(30);
    expect(subtractMoney(money(2800, 'EUR'), money(1000, 'EUR')).amount).toBe(1800);
  });

  it('applies commission in basis points with half-up rounding', () => {
    // 12.5% of 28.00 EUR = 3.50 EUR
    expect(applyBasisPoints(money(2800, 'EUR'), 1250).amount).toBe(350);
    // 15% of 10.01 EUR = 1.5015 -> 1.50
    expect(applyBasisPoints(money(1001, 'EUR'), 1500).amount).toBe(150);
    expect(applyBasisPoints(money(0, 'EUR'), 1250).amount).toBe(0);
    // 5% of 0.10 EUR = 0.005 EUR exactement, un .5 pile : half-up doit monter a 1.
    expect(applyBasisPoints(money(10, 'EUR'), 500).amount).toBe(1);
  });

  it('computes the discount shown on offer cards', () => {
    expect(discountPercent(money(2800, 'EUR'), money(1000, 'EUR'))).toBe(64);
    expect(discountPercent(money(2800, 'EUR'), money(2800, 'EUR'))).toBe(0);
    expect(discountPercent(money(0, 'EUR'), money(0, 'EUR'))).toBe(0);
  });

  it('round-trips decimal strings without precision loss', () => {
    expect(parseDecimalToMinor('10.00', 'EUR').amount).toBe(1000);
    expect(parseDecimalToMinor('10', 'EUR').amount).toBe(1000);
    expect(parseDecimalToMinor('0.05', 'EUR').amount).toBe(5);
    expect(parseDecimalToMinor('12,50', 'EUR').amount).toBe(1250);
    expect(toDecimalString(money(1250, 'EUR'))).toBe('12.50');
    expect(toDecimalString(money(5, 'EUR'))).toBe('0.05');
  });

  it('rejects amounts more precise than the currency', () => {
    expect(() => parseDecimalToMinor('10.005', 'EUR')).toThrow(MoneyError);
  });

  it('formats for the Belgian market and honours the free label', () => {
    expect(formatMoney(money(0, 'EUR'), { freeLabel: 'Gratuit' })).toBe('Gratuit');
    // Intl uses a narrow no-break space in fr-BE; assert on the parts that matter.
    expect(formatMoney(money(1000, 'EUR'), { compactWholeAmounts: true })).toContain('10');
    expect(formatMoney(money(1050, 'EUR'))).toContain('10,50');
  });
});

describe('refundedFeeAt', () => {
  it('renverse exactement la commission preleve quand le remboursement est total', () => {
    // (2*Fee*A + A) / (2A) = Fee + 1/2, qui plancher-arrondit toujours a Fee.
    const cases: Array<{ amount: number; bp: number }> = [
      { amount: 1000, bp: 1500 },
      { amount: 1000, bp: 2500 },
      { amount: 3, bp: 2500 },
      { amount: 2500, bp: 1250 },
      { amount: 1, bp: 10000 },
      { amount: 999_983, bp: 3333 },
    ];
    for (const { amount, bp } of cases) {
      const fee = applyBasisPoints(money(amount, 'EUR'), bp).amount;
      expect(refundedFeeAt({ amount, platformFee: fee, refundedCumulative: amount })).toBe(fee);
    }
  });

  it('rend zero pour un cumul nul, quel que soit le brut', () => {
    expect(refundedFeeAt({ amount: 1000, platformFee: 150, refundedCumulative: 0 })).toBe(0);
  });

  it('rejette un cumul rembourse superieur au brut', () => {
    expect(() =>
      refundedFeeAt({ amount: 1000, platformFee: 150, refundedCumulative: 1001 }),
    ).toThrow(MoneyError);
  });

  it('rejette une commission superieure au brut', () => {
    expect(() =>
      refundedFeeAt({ amount: 1000, platformFee: 1001, refundedCumulative: 500 }),
    ).toThrow(MoneyError);
  });

  it('rejette les non-entiers et les negatifs', () => {
    expect(() =>
      refundedFeeAt({ amount: 1000.5, platformFee: 150, refundedCumulative: 500 }),
    ).toThrow(MoneyError);
    expect(() =>
      refundedFeeAt({ amount: 1000, platformFee: -1, refundedCumulative: 500 }),
    ).toThrow(MoneyError);
    expect(() =>
      refundedFeeAt({ amount: 1000, platformFee: 150, refundedCumulative: -1 }),
    ).toThrow(MoneyError);
  });
});

describe('allocateRefundLine', () => {
  it('ventile la sequence de reference a 1500bp (A=1000, Fee=150, Merch=850)', () => {
    const amount = 1000;
    const platformFee = 150;

    // Remboursement total en une fois.
    expect(
      allocateRefundLine({ amount, platformFee, refundedBefore: 0, lineAmount: 1000 }),
    ).toEqual({ platformFeeAmount: 150, merchantAmount: 850 });

    // Un seul partiel de 300.
    expect(
      allocateRefundLine({ amount, platformFee, refundedBefore: 0, lineAmount: 300 }),
    ).toEqual({ platformFeeAmount: 45, merchantAmount: 255 });

    // Trois tranches 333 / 333 / 334 qui doivent teleskoper exactement sur Fee et Merch.
    const line1 = allocateRefundLine({ amount, platformFee, refundedBefore: 0, lineAmount: 333 });
    expect(line1).toEqual({ platformFeeAmount: 50, merchantAmount: 283 });

    const line2 = allocateRefundLine({
      amount,
      platformFee,
      refundedBefore: 333,
      lineAmount: 333,
    });
    expect(line2).toEqual({ platformFeeAmount: 50, merchantAmount: 283 });

    const line3 = allocateRefundLine({
      amount,
      platformFee,
      refundedBefore: 666,
      lineAmount: 334,
    });
    expect(line3).toEqual({ platformFeeAmount: 50, merchantAmount: 284 });

    expect(line1.platformFeeAmount + line2.platformFeeAmount + line3.platformFeeAmount).toBe(150);
    expect(line1.merchantAmount + line2.merchantAmount + line3.merchantAmount).toBe(850);

    // Micro-montants : 1 centime, puis +4 centimes.
    const cent1 = allocateRefundLine({ amount, platformFee, refundedBefore: 0, lineAmount: 1 });
    expect(cent1).toEqual({ platformFeeAmount: 0, merchantAmount: 1 });
    const cent2 = allocateRefundLine({ amount, platformFee, refundedBefore: 1, lineAmount: 4 });
    expect(cent2).toEqual({ platformFeeAmount: 1, merchantAmount: 3 });
  });

  it('ventile la sequence de reference a 2500bp (A=1000, Fee=250, Merch=750)', () => {
    const amount = 1000;
    const platformFee = 250;

    expect(
      allocateRefundLine({ amount, platformFee, refundedBefore: 0, lineAmount: 1000 }),
    ).toEqual({ platformFeeAmount: 250, merchantAmount: 750 });

    expect(
      allocateRefundLine({ amount, platformFee, refundedBefore: 0, lineAmount: 300 }),
    ).toEqual({ platformFeeAmount: 75, merchantAmount: 225 });

    const line1 = allocateRefundLine({ amount, platformFee, refundedBefore: 0, lineAmount: 333 });
    expect(line1).toEqual({ platformFeeAmount: 83, merchantAmount: 250 });

    const line2 = allocateRefundLine({
      amount,
      platformFee,
      refundedBefore: 333,
      lineAmount: 333,
    });
    // 83 -> 167, part de cette ligne = 167 - 83 = 84 : la ligne du milieu absorbe l'arrondi.
    expect(line2).toEqual({ platformFeeAmount: 84, merchantAmount: 249 });

    const line3 = allocateRefundLine({
      amount,
      platformFee,
      refundedBefore: 666,
      lineAmount: 334,
    });
    expect(line3).toEqual({ platformFeeAmount: 83, merchantAmount: 251 });

    expect(line1.platformFeeAmount + line2.platformFeeAmount + line3.platformFeeAmount).toBe(250);
    expect(line1.merchantAmount + line2.merchantAmount + line3.merchantAmount).toBe(750);

    const cent1 = allocateRefundLine({ amount, platformFee, refundedBefore: 0, lineAmount: 1 });
    expect(cent1).toEqual({ platformFeeAmount: 0, merchantAmount: 1 });
    const cent2 = allocateRefundLine({ amount, platformFee, refundedBefore: 1, lineAmount: 1 });
    expect(cent2).toEqual({ platformFeeAmount: 1, merchantAmount: 0 });
  });

  it('cas dur : A=3, bp=2500 (Fee=1) rembourse en 1+1+1', () => {
    const amount = 3;
    const platformFee = 1; // applyBasisPoints(3, 2500) === 1 (half-up de 0.75)

    const l1 = allocateRefundLine({ amount, platformFee, refundedBefore: 0, lineAmount: 1 });
    const l2 = allocateRefundLine({ amount, platformFee, refundedBefore: 1, lineAmount: 1 });
    const l3 = allocateRefundLine({ amount, platformFee, refundedBefore: 2, lineAmount: 1 });

    expect([l1.platformFeeAmount, l2.platformFeeAmount, l3.platformFeeAmount]).toEqual([0, 1, 0]);
    expect([l1.merchantAmount, l2.merchantAmount, l3.merchantAmount]).toEqual([1, 0, 1]);
    expect(l1.platformFeeAmount + l2.platformFeeAmount + l3.platformFeeAmount).toBe(1);
    expect(l1.merchantAmount + l2.merchantAmount + l3.merchantAmount).toBe(2);
  });

  it('cas dur : A=2500, bp=1250 (Fee=313) rembourse en 1250+1250', () => {
    const amount = 2500;
    const platformFee = 313; // applyBasisPoints(2500, 1250) === 313 (half-up de 312.5)

    const l1 = allocateRefundLine({ amount, platformFee, refundedBefore: 0, lineAmount: 1250 });
    const l2 = allocateRefundLine({ amount, platformFee, refundedBefore: 1250, lineAmount: 1250 });

    expect(l1.platformFeeAmount).toBe(157);
    expect(l2.platformFeeAmount).toBe(156);
    expect(l1.platformFeeAmount + l2.platformFeeAmount).toBe(313);
  });

  // 30 s de delai explicite, et non le defaut de 5 s. Ce balayage est
  // DETERMINISTE — mulberry32 a graine fixe — donc il ne « passe » ni ne
  // « casse » au hasard : il parcourt 2000 partitions et leurs permutations,
  // ce qui prend quelques secondes sur une machine libre et davantage sur une
  // machine chargee. Constate le 26 aout : echec a 9,1 s pendant que trois
  // compilations tournaient en parallele.
  //
  // Un test d'argent qui tombe sous la charge apprend a relancer au lieu de
  // lire — exactement le defaut qu'on a refuse ailleurs cette semaine. Le
  // delai est donc pose pour ce qu'il est : le cout reel du balayage, pas une
  // tolerance a une intermittence.
  it('property: pour toute partition aleatoire d\'un montant, les parts telescopent exactement', { timeout: 30_000 }, () => {
    // PRNG a graine fixe (mulberry32) : reproductible sans dependance externe.
    function mulberry32(seed: number): () => number {
      let a = seed;
      return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const rand = mulberry32(20260815);
    const randInt = (min: number, max: number): number =>
      min + Math.floor(rand() * (max - min + 1));

    for (let trial = 0; trial < 2000; trial += 1) {
      const amount = randInt(1, 1_000_000);
      const bp = randInt(0, 10_000);
      const platformFee = applyBasisPoints(money(amount, 'EUR'), bp).amount;

      const partsCount = randInt(1, Math.min(50, amount));
      // Partition de `amount` en `partsCount` parts strictement positives : on tire
      // partsCount - 1 points de coupure distincts dans [1, amount - 1].
      const cuts = new Set<number>();
      while (cuts.size < partsCount - 1) {
        cuts.add(randInt(1, amount - 1));
      }
      const sortedCuts = [0, ...Array.from(cuts).sort((a, b) => a - b), amount];
      const lineAmounts: number[] = [];
      for (let i = 0; i < sortedCuts.length - 1; i += 1) {
        lineAmounts.push(sortedCuts[i + 1]! - sortedCuts[i]!);
      }

      let refundedBefore = 0;
      let feeSum = 0;
      let merchantSum = 0;
      for (const lineAmount of lineAmounts) {
        const { platformFeeAmount, merchantAmount } = allocateRefundLine({
          amount,
          platformFee,
          refundedBefore,
          lineAmount,
        });
        expect(platformFeeAmount).toBeGreaterThanOrEqual(0);
        expect(platformFeeAmount).toBeLessThanOrEqual(lineAmount);
        expect(merchantAmount).toBeGreaterThanOrEqual(0);
        expect(merchantAmount).toBeLessThanOrEqual(lineAmount);
        feeSum += platformFeeAmount;
        merchantSum += merchantAmount;
        refundedBefore += lineAmount;
      }

      expect(feeSum).toBe(platformFee);
      expect(merchantSum).toBe(amount - platformFee);

      // L'invariance par permutation : rejouer les memes lignes dans un autre ordre
      // doit teleskoper sur le meme total (pas necessairement la meme ventilation
      // ligne a ligne, puisque l'arrondi depend de l'ordre d'arrivee).
      const shuffled = [...lineAmounts];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      let refundedBefore2 = 0;
      let feeSum2 = 0;
      let merchantSum2 = 0;
      for (const lineAmount of shuffled) {
        const { platformFeeAmount, merchantAmount } = allocateRefundLine({
          amount,
          platformFee,
          refundedBefore: refundedBefore2,
          lineAmount,
        });
        feeSum2 += platformFeeAmount;
        merchantSum2 += merchantAmount;
        refundedBefore2 += lineAmount;
      }
      expect(feeSum2).toBe(platformFee);
      expect(merchantSum2).toBe(amount - platformFee);
    }
  });
});
