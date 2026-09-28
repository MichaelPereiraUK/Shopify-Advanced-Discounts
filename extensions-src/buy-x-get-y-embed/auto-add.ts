// Buy X range, get Y: adds the free Y variants to the cart once every X item
// is present. The discount itself is applied by the buy-x-get-y function; this
// script only adds items (it never removes items the customer chose).
//
// Compiled to extensions/buy-x-get-y-embed/assets/auto-add.js by
// `npm run build:embed`. Edit this file, not the compiled output.

type XItem = {type: 'product' | 'variant'; id: string};

type Rule = {
  discountId: string | null;
  xItems: XItem[];
  yVariantIds: string[];
  usesPerOrder: number;
};

type Config = {
  rules: Record<string, Rule>;
  refresh: 'none' | 'cart_page' | 'always';
};

type CartItem = {
  key: string;
  variant_id: number;
  product_id: number;
  quantity: number;
  properties: Record<string, string> | null;
  original_price: number;
  original_line_price: number;
  final_line_price: number;
};

type Cart = {
  item_count: number;
  items: CartItem[];
  discount_codes?: {code: string; applicable: boolean}[];
};

type HandledState = Record<string, {level: number; codes: string}>;

// [numeric variant ID, quantity]
type Added = [number, number];

// The parts of https://cdn.shopify.com/storefront/standard-events.js used here.
type Deferred<T> = {promise: Promise<T>; resolve: (value: T) => void};
type StandardEventsModule = {
  CartLinesUpdateEvent: {
    new (init: {
      action: 'add' | 'update';
      lines: ({merchandiseId: string} | {id: string})[];
      promise: Promise<unknown>;
    }): Event;
    createPromise(): Deferred<unknown>;
    createCartFromAjaxResponse(cart: Cart): unknown;
  };
};

declare global {
  interface Window {
    Shopify?: {routes?: {root?: string}};
  }
}

const RULE_PROPERTY = '_bxgy_rule';
const STORAGE_KEY = 'bxgy-auto-add';
const CART_MUTATION = /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/;
const STANDARD_EVENTS_URL = 'https://cdn.shopify.com/storefront/standard-events.js';

function readConfig(): Config | null {
  const element = document.getElementById('bxgy-auto-add-config');
  if (!element?.textContent) return null;
  try {
    return JSON.parse(element.textContent) as Config;
  } catch {
    return null;
  }
}

const config = readConfig();
const rules = Object.entries(config?.rules ?? {}).filter(
  ([, rule]) => rule.xItems?.length && rule.yVariantIds?.length,
);

if (config && rules.length) {
  start(config, rules);
}

function start(config: Config, rules: [string, Rule][]) {
  const root = window.Shopify?.routes?.root ?? '/';
  const nativeFetch = window.fetch.bind(window);

  const cartRequest = async <T = Cart>(path: string, body?: unknown): Promise<T> => {
    const response = await nativeFetch(`${root}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {'Content-Type': 'application/json', Accept: 'application/json'},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`${path} failed with ${response.status}`);
    return response.json() as Promise<T>;
  };

  // Per rule, the number of applications we've already added Y for in this
  // session, and the discount codes applied at the time. We only add when the
  // customer reaches a higher number (or the codes change), so a Y the
  // customer removes isn't re-added over and over.
  const readHandled = (): HandledState => {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}') ?? {};
    } catch {
      return {};
    }
  };
  const writeHandled = (handled: HandledState) => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(handled));
    } catch {
      // Storage unavailable; worst case we re-evaluate on the next page.
    }
  };

  let running = false;
  let queued = false;

  const evaluate = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    let latestCart: Cart | undefined;
    const allAdded: Added[] = [];
    let changed = false;

    try {
      const handled = readHandled();
      let cart = await cartRequest('cart.js');
      const codes = codesSignature(cart);
      // Y units already counted towards an earlier rule, so rules that share a
      // Y variant each get their own units.
      const claimed: Record<number, number> = {};
      const available = (id: number) => quantityOf(cart.items, id) - (claimed[id] ?? 0);
      const claim = (id: number, quantity: number) => {
        claimed[id] = (claimed[id] ?? 0) + quantity;
      };

      for (const [ruleId, rule] of rules) {
        const target = Math.min(completeSets(rule, cart.items), Math.max(1, rule.usesPerOrder || 1));
        const yIds = rule.yVariantIds.map(numericId);
        const previous = handled[ruleId]?.codes === codes ? handled[ruleId].level : 0;
        handled[ruleId] = {level: target, codes};

        if (target <= previous) {
          // Nothing new to add. A lower target resets the level so reaching it
          // again later triggers another add.
          yIds.forEach((id) => claim(id, Math.min(target, Math.max(0, available(id)))));
          continue;
        }

        const added: Added[] = yIds
          .map((id): Added => [id, target - available(id)])
          .filter(([, quantity]) => quantity > 0);

        if (!added.length) {
          yIds.forEach((id) => claim(id, target));
          continue;
        }

        try {
          await cartRequest('cart/add.js', {
            items: added.map(([id, quantity]) => ({id, quantity, properties: {[RULE_PROPERTY]: ruleId}})),
          });
          changed = true;
          allAdded.push(...added);
          await undoUndiscountedAdds(ruleId, added);
        } catch (error) {
          console.warn('[bxgy] Unable to add free item', error);
        }
        cart = await cartRequest('cart.js');
        yIds.forEach((id) => claim(id, Math.min(target, Math.max(0, available(id)))));
      }

      writeHandled(handled);
      latestCart = cart;
    } catch (error) {
      console.warn('[bxgy] Unable to evaluate cart', error);
    } finally {
      running = false;
    }

    if (changed && latestCart) {
      try {
        await notifyCartChanged(latestCart, allAdded);
      } catch (error) {
        console.warn('[bxgy] Unable to refresh the cart', error);
      }
    }
    if (queued) {
      queued = false;
      evaluate();
    }
  };

  // If Shopify didn't make what we added free (the discount has expired, the
  // customer isn't eligible, a code hasn't been entered, and so on), take back
  // the units we added that aren't free, so the customer isn't charged for an
  // item they didn't choose. Units that were already on the line are kept.
  const undoUndiscountedAdds = async (ruleId: string, added: Added[]) => {
    const cart = await cartRequest('cart.js');
    for (const [variantId, quantity] of added) {
      const line = cart.items.find(
        (item) => item.variant_id === variantId && item.properties?.[RULE_PROPERTY] === ruleId,
      );
      if (!line) continue;
      const keep = Math.max(line.quantity - quantity, freeUnits(line));
      if (keep < line.quantity) {
        await cartRequest('cart/change.js', {id: line.key, quantity: keep});
      }
    }
  };

  const notifyCartChanged = async (cart: Cart, added: Added[]) => {
    await dispatchStandardCartEvent(cart, added);
    document.dispatchEvent(new CustomEvent('bxgy:cart-updated', {bubbles: true, detail: {cart}}));

    const onCartPage = window.location.pathname.replace(/\/$/, '').endsWith('/cart');
    if (config.refresh === 'always' || (config.refresh === 'cart_page' && onCartPage)) {
      window.location.reload();
    }
  };

  // Themes built on Shopify's standard storefront events (such as Horizon)
  // refresh their cart drawer and count from CartLinesUpdateEvent. Like the
  // theme's own add to cart, the rendered cart sections are sent with the
  // event, so the theme morphs them in directly instead of refetching.
  const dispatchStandardCartEvent = async (cart: Cart, added: Added[]) => {
    let events: StandardEventsModule;
    try {
      events = (await import(/* @vite-ignore */ STANDARD_EVENTS_URL)) as StandardEventsModule;
    } catch {
      return; // Not a standard-events theme; the custom event and reload setting cover it.
    }
    const {CartLinesUpdateEvent} = events;
    if (!CartLinesUpdateEvent) return;

    // Everything is prepared before dispatching, so the event's promise is
    // always resolved. A pending promise would leave the theme's cart stuck.
    const sections = await renderCartSections();
    let standardCart: unknown = null;
    try {
      standardCart = CartLinesUpdateEvent.createCartFromAjaxResponse(cart);
    } catch {
      // The theme falls back to detail.itemCount for its cart count.
    }

    // Only report an add if Y is still in the cart, so the theme doesn't open
    // its drawer for an item that was taken straight back out.
    const kept = added.filter(([id]) => cart.items.some((item) => item.variant_id === id));
    const deferred = CartLinesUpdateEvent.createPromise();
    document.dispatchEvent(
      new CartLinesUpdateEvent(
        kept.length
          ? {
              action: 'add',
              lines: kept.map(([id, quantity]) => ({merchandiseId: String(id), quantity})),
              promise: deferred.promise,
            }
          : {action: 'update', lines: [], promise: deferred.promise},
      ),
    );
    deferred.resolve({
      cart: standardCart,
      detail: {items: cart.items, itemCount: cart.item_count, source: 'bxgy-auto-add', sections},
    });
  };

  // Rendered HTML of the theme's cart sections (Horizon marks them with
  // cart-items-component[data-section-id]), in the context of the current page.
  const renderCartSections = async (): Promise<Record<string, string> | undefined> => {
    const sectionIds = [
      ...new Set(
        [...document.querySelectorAll<HTMLElement>('cart-items-component[data-section-id]')]
          .map((element) => element.dataset.sectionId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (!sectionIds.length) return undefined;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('sections', sectionIds.join(','));
      const response = await nativeFetch(url.toString(), {headers: {Accept: 'application/json'}});
      return response.ok ? ((await response.json()) as Record<string, string>) : undefined;
    } catch {
      return undefined;
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleEvaluate = () => {
    clearTimeout(timer);
    timer = setTimeout(evaluate, 300);
  };

  // Re-evaluate after the theme changes the cart (fetch and XHR).
  window.fetch = function (resource: RequestInfo | URL, init?: RequestInit) {
    const url =
      typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
    const result = nativeFetch(resource, init);
    if (CART_MUTATION.test(url)) {
      result.then(scheduleEvaluate, () => {});
    }
    return result;
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: [boolean?, string?, string?]
  ) {
    if (CART_MUTATION.test(String(url))) {
      this.addEventListener('load', scheduleEvaluate);
    }
    return (nativeOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;

  document.addEventListener('cart:updated', scheduleEvaluate);
  evaluate();
}

function numericId(gid: string): number {
  return Number(String(gid).split('/').pop());
}

function completeSets(rule: Rule, items: CartItem[]): number {
  const yVariantIds = rule.yVariantIds.map(numericId);
  const xLines = items.filter((item) => !yVariantIds.includes(item.variant_id));
  return Math.min(
    ...rule.xItems.map((xItem) => {
      const id = numericId(xItem.id);
      return xLines
        .filter((item) => (xItem.type === 'product' ? item.product_id === id : item.variant_id === id))
        .reduce((total, item) => total + item.quantity, 0);
    }),
  );
}

function quantityOf(items: CartItem[], variantId: number): number {
  return items
    .filter((item) => item.variant_id === variantId)
    .reduce((total, item) => total + item.quantity, 0);
}

// Units on a line that are fully free. Other discounts (a site-wide 10% off,
// say) reduce the price without making a unit free, so they don't count.
function freeUnits(item: CartItem): number {
  if (!(item.original_price > 0)) return item.quantity;
  const discount = item.original_line_price - item.final_line_price;
  return Math.min(item.quantity, Math.floor(discount / item.original_price + 1e-6));
}

// Codes can make a code discount start applying without the cart items
// changing, so a change in codes lets rules be evaluated again.
function codesSignature(cart: Cart): string {
  return (cart.discount_codes ?? [])
    .filter((discountCode) => discountCode.applicable)
    .map((discountCode) => discountCode.code.toLowerCase())
    .sort()
    .join(',');
}

export {};
