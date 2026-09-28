// Generated from extensions-src/buy-x-get-y-embed/auto-add.ts by npm run build:embed. Do not edit.
"use strict";
(() => {
  // extensions-src/buy-x-get-y-embed/auto-add.ts
  var RULE_PROPERTY = "_bxgy_rule";
  var STORAGE_KEY = "bxgy-auto-add";
  var CART_MUTATION = /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/;
  var STANDARD_EVENTS_URL = "https://cdn.shopify.com/storefront/standard-events.js";
  function readConfig() {
    const element = document.getElementById("bxgy-auto-add-config");
    if (!element?.textContent) return null;
    try {
      return JSON.parse(element.textContent);
    } catch {
      return null;
    }
  }
  var config = readConfig();
  var rules = Object.entries(config?.rules ?? {}).filter(
    ([, rule]) => rule.xItems?.length && rule.yVariantIds?.length
  );
  if (config && rules.length) {
    start(config, rules);
  }
  function start(config2, rules2) {
    const root = window.Shopify?.routes?.root ?? "/";
    const nativeFetch = window.fetch.bind(window);
    const cartRequest = async (path, body) => {
      const response = await nativeFetch(`${root}${path}`, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body ? JSON.stringify(body) : void 0
      });
      if (!response.ok) throw new Error(`${path} failed with ${response.status}`);
      return response.json();
    };
    const readHandled = () => {
      try {
        return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}") ?? {};
      } catch {
        return {};
      }
    };
    const writeHandled = (handled) => {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(handled));
      } catch {
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
      let latestCart;
      const allAdded = [];
      let changed = false;
      try {
        const handled = readHandled();
        let cart = await cartRequest("cart.js");
        const codes = codesSignature(cart);
        const claimed = {};
        const available = (id) => quantityOf(cart.items, id) - (claimed[id] ?? 0);
        const claim = (id, quantity) => {
          claimed[id] = (claimed[id] ?? 0) + quantity;
        };
        for (const [ruleId, rule] of rules2) {
          const target = Math.min(completeSets(rule, cart.items), Math.max(1, rule.usesPerOrder || 1));
          const yIds = rule.yVariantIds.map(numericId);
          const previous = handled[ruleId]?.codes === codes ? handled[ruleId].level : 0;
          handled[ruleId] = { level: target, codes };
          if (target <= previous) {
            yIds.forEach((id) => claim(id, Math.min(target, Math.max(0, available(id)))));
            continue;
          }
          const added = yIds.map((id) => [id, target - available(id)]).filter(([, quantity]) => quantity > 0);
          if (!added.length) {
            yIds.forEach((id) => claim(id, target));
            continue;
          }
          try {
            await cartRequest("cart/add.js", {
              items: added.map(([id, quantity]) => ({ id, quantity, properties: { [RULE_PROPERTY]: ruleId } }))
            });
            changed = true;
            allAdded.push(...added);
            await undoUndiscountedAdds(ruleId, added);
          } catch (error) {
            console.warn("[bxgy] Unable to add free item", error);
          }
          cart = await cartRequest("cart.js");
          yIds.forEach((id) => claim(id, Math.min(target, Math.max(0, available(id)))));
        }
        writeHandled(handled);
        latestCart = cart;
      } catch (error) {
        console.warn("[bxgy] Unable to evaluate cart", error);
      } finally {
        running = false;
      }
      if (changed && latestCart) {
        try {
          await notifyCartChanged(latestCart, allAdded);
        } catch (error) {
          console.warn("[bxgy] Unable to refresh the cart", error);
        }
      }
      if (queued) {
        queued = false;
        evaluate();
      }
    };
    const undoUndiscountedAdds = async (ruleId, added) => {
      const cart = await cartRequest("cart.js");
      for (const [variantId, quantity] of added) {
        const line = cart.items.find(
          (item) => item.variant_id === variantId && item.properties?.[RULE_PROPERTY] === ruleId
        );
        if (!line) continue;
        const keep = Math.max(line.quantity - quantity, freeUnits(line));
        if (keep < line.quantity) {
          await cartRequest("cart/change.js", { id: line.key, quantity: keep });
        }
      }
    };
    const notifyCartChanged = async (cart, added) => {
      await dispatchStandardCartEvent(cart, added);
      document.dispatchEvent(new CustomEvent("bxgy:cart-updated", { bubbles: true, detail: { cart } }));
      const onCartPage = window.location.pathname.replace(/\/$/, "").endsWith("/cart");
      if (config2.refresh === "always" || config2.refresh === "cart_page" && onCartPage) {
        window.location.reload();
      }
    };
    const dispatchStandardCartEvent = async (cart, added) => {
      let events;
      try {
        events = await import(
          /* @vite-ignore */
          STANDARD_EVENTS_URL
        );
      } catch {
        return;
      }
      const { CartLinesUpdateEvent } = events;
      if (!CartLinesUpdateEvent) return;
      const sections = await renderCartSections();
      let standardCart = null;
      try {
        standardCart = CartLinesUpdateEvent.createCartFromAjaxResponse(cart);
      } catch {
      }
      const kept = added.filter(([id]) => cart.items.some((item) => item.variant_id === id));
      const deferred = CartLinesUpdateEvent.createPromise();
      document.dispatchEvent(
        new CartLinesUpdateEvent(
          kept.length ? {
            action: "add",
            lines: kept.map(([id, quantity]) => ({ merchandiseId: String(id), quantity })),
            promise: deferred.promise
          } : { action: "update", lines: [], promise: deferred.promise }
        )
      );
      deferred.resolve({
        cart: standardCart,
        detail: { items: cart.items, itemCount: cart.item_count, source: "bxgy-auto-add", sections }
      });
    };
    const renderCartSections = async () => {
      const sectionIds = [
        ...new Set(
          [...document.querySelectorAll("cart-items-component[data-section-id]")].map((element) => element.dataset.sectionId).filter((id) => Boolean(id))
        )
      ];
      if (!sectionIds.length) return void 0;
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("sections", sectionIds.join(","));
        const response = await nativeFetch(url.toString(), { headers: { Accept: "application/json" } });
        return response.ok ? await response.json() : void 0;
      } catch {
        return void 0;
      }
    };
    let timer;
    const scheduleEvaluate = () => {
      clearTimeout(timer);
      timer = setTimeout(evaluate, 300);
    };
    window.fetch = function(resource, init) {
      const url = typeof resource === "string" ? resource : resource instanceof URL ? resource.href : resource.url;
      const result = nativeFetch(resource, init);
      if (CART_MUTATION.test(url)) {
        result.then(scheduleEvaluate, () => {
        });
      }
      return result;
    };
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      if (CART_MUTATION.test(String(url))) {
        this.addEventListener("load", scheduleEvaluate);
      }
      return nativeOpen.call(this, method, url, ...rest);
    };
    document.addEventListener("cart:updated", scheduleEvaluate);
    evaluate();
  }
  function numericId(gid) {
    return Number(String(gid).split("/").pop());
  }
  function completeSets(rule, items) {
    const yVariantIds = rule.yVariantIds.map(numericId);
    const xLines = items.filter((item) => !yVariantIds.includes(item.variant_id));
    return Math.min(
      ...rule.xItems.map((xItem) => {
        const id = numericId(xItem.id);
        return xLines.filter((item) => xItem.type === "product" ? item.product_id === id : item.variant_id === id).reduce((total, item) => total + item.quantity, 0);
      })
    );
  }
  function quantityOf(items, variantId) {
    return items.filter((item) => item.variant_id === variantId).reduce((total, item) => total + item.quantity, 0);
  }
  function freeUnits(item) {
    if (!(item.original_price > 0)) return item.quantity;
    const discount = item.original_line_price - item.final_line_price;
    return Math.min(item.quantity, Math.floor(discount / item.original_price + 1e-6));
  }
  function codesSignature(cart) {
    return (cart.discount_codes ?? []).filter((discountCode) => discountCode.applicable).map((discountCode) => discountCode.code.toLowerCase()).sort().join(",");
  }
})();
