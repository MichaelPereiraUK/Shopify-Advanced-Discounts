import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  CartLineTarget,
} from '../generated/api';

type XItem = {
  type: 'product' | 'variant';
  id: string;
};

type Configuration = {
  ruleId?: string;
  xItems?: XItem[];
  yVariantIds?: string[];
  maxUsesPerOrderEnabled?: boolean;
  maxUsesPerOrder?: number;
};

const NO_CHANGES: CartLinesDiscountsGenerateRunResult = {operations: []};

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) {
    return NO_CHANGES;
  }

  const config = (input.discount.metafield?.jsonValue ?? {}) as Configuration;
  const xItems = config.xItems ?? [];
  const yVariantIds = config.yVariantIds ?? [];
  if (!xItems.length || !yVariantIds.length) {
    return NO_CHANGES;
  }

  const usesPerOrder = config.maxUsesPerOrderEnabled
    ? Math.max(1, Math.floor(Number(config.maxUsesPerOrder) || 1))
    : 1;

  const variantLines = input.cart.lines.flatMap((line) =>
    line.merchandise.__typename === 'ProductVariant'
      ? [
          {
            id: line.id,
            quantity: line.quantity,
            variantId: line.merchandise.id,
            productId: line.merchandise.product.id,
            ruleId: line.ruleAttribute?.value ?? null,
          },
        ]
      : [],
  );

  // Y lines never count towards the X requirement.
  const xCandidateLines = variantLines.filter(
    (line) => !yVariantIds.includes(line.variantId),
  );

  // Every X item must be present; the number of complete sets is limited by
  // the X item with the lowest quantity in the cart.
  const completeSets = Math.min(
    ...xItems.map((item) =>
      xCandidateLines
        .filter((line) =>
          item.type === 'product'
            ? line.productId === item.id
            : line.variantId === item.id,
        )
        .reduce((total, line) => total + line.quantity, 0),
    ),
  );

  const applications = Math.min(completeSets, usesPerOrder);
  if (applications <= 0) {
    return NO_CHANGES;
  }

  // Y lines the storefront added for this rule are used first, then lines the
  // customer added, and lines added for another rule last. This way discounts
  // that share a Y variant each discount their own units.
  const linePriority = (ruleId: string | null) =>
    ruleId && ruleId === config.ruleId ? 0 : ruleId ? 2 : 1;
  const yLines = [...variantLines].sort(
    (a, b) => linePriority(a.ruleId) - linePriority(b.ruleId),
  );

  const targets: {cartLine: CartLineTarget}[] = [];
  for (const yVariantId of yVariantIds) {
    let remaining = applications;
    for (const line of yLines) {
      if (remaining <= 0) break;
      if (line.variantId !== yVariantId) continue;
      const quantity = Math.min(line.quantity, remaining);
      targets.push({cartLine: {id: line.id, quantity}});
      remaining -= quantity;
    }
  }

  if (!targets.length) {
    return NO_CHANGES;
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [
            {
              message: 'Free gift',
              targets,
              value: {
                percentage: {
                  value: 100,
                },
              },
            },
          ],
          selectionStrategy: ProductDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}
