import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useState, useEffect, useMemo} from "preact/hooks";

// Not the app-reserved `$app` namespace: the discount page saves this metafield
// as the merchant, and merchants can't update app-reserved metafields.
const METAFIELD_NAMESPACE = "buy-x-range-get-y";
const METAFIELD_KEY = "function-configuration";

// App-installation metafield mirrored for the theme app embed, which can't
// read discount metafields. Only the app-reserved namespace is writable from
// the extension. Read in Liquid as `app.metafields["$app:bxgy"].rules`.
const STOREFRONT_NAMESPACE = "$app:bxgy";
const STOREFRONT_KEY = "rules";

export default async () => {
  render(<App />, document.body);
};

function App() {
  const {
    i18n,
    loading,
    xItems,
    yVariants,
    initialXItems,
    initialYVariants,
    initialMaxUses,
    maxUsesPerOrderEnabled,
    maxUsesPerOrder,
    errors,
    onSelectXItems,
    onSelectYVariants,
    removeXItem,
    removeYVariant,
    setMaxUsesPerOrderEnabled,
    setMaxUsesPerOrder,
    applyExtensionMetafieldChange,
    resetForm,
  } = useExtensionData();

  if (loading) {
    return <s-text>{i18n.translate("loading")}</s-text>;
  }

  return (
    <s-function-settings
      onSubmit={event => {
        event.waitUntil?.(applyExtensionMetafieldChange());
      }}
      onReset={resetForm}
    >
      <s-heading>{i18n.translate("title")}</s-heading>
      {/* The pickers aren't form fields, so these hidden fields let the
          discount page detect changes and show its save bar. */}
      <s-box display="none">
        <s-text-field
          label=""
          name="xItems"
          value={serializeIds(xItems)}
          defaultValue={serializeIds(initialXItems)}
        />
        <s-text-field
          label=""
          name="yVariants"
          value={serializeIds(yVariants)}
          defaultValue={serializeIds(initialYVariants)}
        />
      </s-box>
      <s-stack gap="base">
        {errors.length ? (
          <s-banner tone="critical">
            {errors.map(error => (
              <s-paragraph key={error}>{error}</s-paragraph>
            ))}
          </s-banner>
        ) : null}

        <s-section heading={i18n.translate("x.heading")}>
          <s-stack gap="base">
            <s-paragraph>{i18n.translate("x.help")}</s-paragraph>
            <s-box>
              <s-button onClick={onSelectXItems}>
                {i18n.translate("x.browse")}
              </s-button>
            </s-box>
            <ResourceList
              items={xItems}
              onClickRemove={removeXItem}
              emptyText={i18n.translate("x.empty")}
            />
          </s-stack>
        </s-section>

        <s-section heading={i18n.translate("y.heading")}>
          <s-stack gap="base">
            <s-paragraph>{i18n.translate("y.help")}</s-paragraph>
            <s-box>
              <s-button onClick={onSelectYVariants}>
                {i18n.translate("y.browse")}
              </s-button>
            </s-box>
            <ResourceList
              items={yVariants}
              onClickRemove={removeYVariant}
              emptyText={i18n.translate("y.empty")}
            />
          </s-stack>
        </s-section>

        <s-section heading={i18n.translate("maxUses.heading")}>
          <s-stack gap="base">
            <s-checkbox
              label={i18n.translate("maxUses.label")}
              checked={maxUsesPerOrderEnabled}
              defaultChecked={initialMaxUses.enabled}
              onChange={event =>
                setMaxUsesPerOrderEnabled(event.currentTarget.checked)
              }
            />
            {maxUsesPerOrderEnabled ? (
              <s-number-field
                label={i18n.translate("maxUses.inputLabel")}
                name="maxUsesPerOrder"
                value={maxUsesPerOrder}
                defaultValue={String(initialMaxUses.value)}
                min={1}
                step={1}
                onChange={event =>
                  setMaxUsesPerOrder(event.currentTarget.value)
                }
              />
            ) : null}
          </s-stack>
        </s-section>
      </s-stack>
    </s-function-settings>
  );
}

function ResourceList({items, onClickRemove, emptyText}) {
  if (items.length === 0) {
    return <s-text color="subdued">{emptyText}</s-text>;
  }

  return items.map(item => (
    <s-stack
      direction="inline"
      alignItems="center"
      justifyContent="space-between"
      key={item.id}
    >
      <s-stack direction="inline" alignItems="center" gap="small">
        <s-thumbnail src={item.image ?? ""} alt={item.title} size="small" />
        <s-link
          href={`shopify://admin/products/${item.productId.split("/").pop()}`}
          target="_blank"
        >
          {item.title}
        </s-link>
      </s-stack>
      <s-button variant="tertiary" onClick={() => onClickRemove(item.id)}>
        <s-icon type="x-circle" />
      </s-button>
    </s-stack>
  ));
}

function useExtensionData() {
  const {applyMetafieldChange, i18n, data, resourcePicker, query, discounts} =
    shopify;

  const metafieldConfig = useMemo(
    () =>
      parseMetafield(
        data?.metafields?.find(
          metafield =>
            metafield.namespace === METAFIELD_NAMESPACE &&
            metafield.key === METAFIELD_KEY,
        )
          ?.value,
      ),
    [data?.metafields],
  );

  const [initialXItems, setInitialXItems] = useState([]);
  const [initialYVariants, setInitialYVariants] = useState([]);
  const [xItems, setXItems] = useState([]);
  const [yVariants, setYVariants] = useState([]);
  const [maxUsesPerOrderEnabled, setMaxUsesPerOrderEnabled] = useState(
    metafieldConfig.maxUsesPerOrderEnabled,
  );
  const [maxUsesPerOrder, setMaxUsesPerOrder] = useState(
    String(metafieldConfig.maxUsesPerOrder),
  );
  // Kept in state so repeat saves before the page reloads its metafields
  // reuse the same ID instead of creating a second storefront rule.
  const [ruleId, setRuleId] = useState(metafieldConfig.ruleId);
  const [loading, setLoading] = useState(false);
  const [saveError, setSaveError] = useState();

  // This rule type only discounts cart lines.
  useEffect(() => {
    const classes = discounts?.discountClasses?.value ?? [];
    if (classes.length !== 1 || classes[0] !== "product") {
      discounts?.updateDiscountClasses?.(["product"]);
    }
  }, [discounts]);

  useEffect(() => {
    if (metafieldConfig.ruleId) setRuleId(metafieldConfig.ruleId);
  }, [metafieldConfig.ruleId]);

  useEffect(() => {
    const fetchResources = async () => {
      setLoading(true);
      const {xItems, yVariants} = await getResources(metafieldConfig, query);
      setInitialXItems(xItems);
      setXItems(xItems);
      setInitialYVariants(yVariants);
      setYVariants(yVariants);
      setLoading(false);
    };
    fetchResources();
  }, [metafieldConfig, query]);

  const usesPerOrder = Number(maxUsesPerOrder);
  const maxUsesInvalid =
    maxUsesPerOrderEnabled &&
    !(Number.isInteger(usesPerOrder) && usesPerOrder >= 1);

  // Live validation only; the result of the last save is tracked separately
  // so a failed save doesn't block the next one.
  const validationErrors = useMemo(() => {
    const messages = [];
    const yIds = new Set(yVariants.map(({id}) => id));
    const yProductIds = new Set(yVariants.map(({productId}) => productId));
    const overlaps = xItems.some(item =>
      item.type === "product" ? yProductIds.has(item.id) : yIds.has(item.id),
    );
    if (overlaps) messages.push(i18n.translate("errors.overlap"));
    if (maxUsesInvalid) messages.push(i18n.translate("errors.maxUses"));
    return messages;
  }, [xItems, yVariants, maxUsesInvalid, i18n]);

  // A previous save's error no longer applies once the selection changes.
  useEffect(() => {
    setSaveError(undefined);
  }, [xItems, yVariants]);

  const errors = saveError
    ? [...validationErrors, saveError]
    : validationErrors;

  async function applyExtensionMetafieldChange() {
    setSaveError(undefined);
    if (!xItems.length || !yVariants.length) {
      const message = i18n.translate("errors.required");
      setSaveError(message);
      throw new Error(message);
    }
    if (validationErrors.length) {
      throw new Error(validationErrors.join(" "));
    }

    const savedRuleId = ruleId || createRuleId();
    setRuleId(savedRuleId);

    const configuration = {
      ruleId: savedRuleId,
      xItems: xItems.map(({type, id, productId}) =>
        type === "product" ? {type, id} : {type, id, productId},
      ),
      yVariantIds: yVariants.map(({id}) => id),
      maxUsesPerOrderEnabled,
      maxUsesPerOrder: maxUsesPerOrderEnabled ? usesPerOrder : 1,
    };

    await applyMetafieldChange({
      type: "updateMetafield",
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY,
      value: JSON.stringify(configuration),
      valueType: "json",
    });

    try {
      await saveStorefrontRule(configuration, data?.id, query);
    } catch (error) {
      console.error(error);
      setSaveError(
        `${i18n.translate("errors.storefront")} (${error?.message ?? error})`,
      );
    }

    setInitialXItems(xItems);
    setInitialYVariants(yVariants);
  }

  const resetForm = () => {
    setXItems(initialXItems);
    setYVariants(initialYVariants);
    setMaxUsesPerOrderEnabled(metafieldConfig.maxUsesPerOrderEnabled);
    setMaxUsesPerOrder(String(metafieldConfig.maxUsesPerOrder));
    setSaveError(undefined);
  };

  const onSelectXItems = async () => {
    const selection = await resourcePicker({
      type: "product",
      action: "select",
      multiple: true,
      selectionIds: toProductSelectionIds(xItems),
      filter: {variants: true},
    });
    if (!selection) return;
    // Picker payloads can omit titles, so names are loaded from the Admin API.
    const selectedXItems = selection.flatMap(product => {
      const variants = product.variants ?? [];
      if (!variants.length || variants.length >= product.totalVariants) {
        return [{type: "product", id: product.id}];
      }
      return variants.map(variant => ({type: "variant", id: variant.id}));
    });
    const resolved = await getResources(
      {xItems: selectedXItems, yVariantIds: []},
      query,
    );
    setXItems(resolved.xItems);
  };

  // Uses the product picker (the variant picker lists single-variant products
  // as an untitled "Default Title" row with no image). Y is always stored as
  // specific variants: the ones ticked, or every variant of a product picked
  // without ticking variants.
  const onSelectYVariants = async () => {
    const selection = await resourcePicker({
      type: "product",
      action: "select",
      multiple: true,
      selectionIds: toProductSelectionIds(
        yVariants.map(variant => ({...variant, type: "variant"})),
      ),
      filter: {variants: true},
    });
    if (!selection) return;
    const variantIds = await selectedVariantIds(selection, query);
    const resolved = await getResources(
      {xItems: [], yVariantIds: variantIds},
      query,
    );
    setYVariants(resolved.yVariants);
  };

  const removeXItem = id => {
    setXItems(prev => prev.filter(item => item.id !== id));
  };

  const removeYVariant = id => {
    setYVariants(prev => prev.filter(variant => variant.id !== id));
  };

  return {
    i18n,
    loading,
    xItems,
    yVariants,
    initialXItems,
    initialYVariants,
    initialMaxUses: {
      enabled: metafieldConfig.maxUsesPerOrderEnabled,
      value: metafieldConfig.maxUsesPerOrder,
    },
    maxUsesPerOrderEnabled,
    maxUsesPerOrder,
    errors,
    onSelectXItems,
    onSelectYVariants,
    removeXItem,
    removeYVariant,
    setMaxUsesPerOrderEnabled,
    setMaxUsesPerOrder,
    applyExtensionMetafieldChange,
    resetForm,
  };
}

function parseMetafield(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return {
      ruleId: parsed.ruleId ?? "",
      xItems: parsed.xItems ?? [],
      yVariantIds: parsed.yVariantIds ?? [],
      maxUsesPerOrderEnabled: Boolean(parsed.maxUsesPerOrderEnabled),
      maxUsesPerOrder: Math.max(1, Number(parsed.maxUsesPerOrder) || 1),
    };
  } catch {
    return {
      ruleId: "",
      xItems: [],
      yVariantIds: [],
      maxUsesPerOrderEnabled: false,
      maxUsesPerOrder: 1,
    };
  }
}

function createRuleId() {
  return `bxgy_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Groups variant entries under their product so the picker reopens with the
// same selection.
function toProductSelectionIds(xItems) {
  const byProduct = new Map();
  for (const item of xItems) {
    if (item.type === "product") {
      byProduct.set(item.id, {id: item.id});
    } else {
      const entry = byProduct.get(item.productId) ?? {
        id: item.productId,
        variants: [],
      };
      entry.variants?.push({id: item.id});
      byProduct.set(item.productId, entry);
    }
  }
  return [...byProduct.values()];
}

async function getResources(config, adminApiQuery) {
  const ids = [
    ...config.xItems.map(({id}) => id),
    ...config.yVariantIds,
  ];
  if (!ids.length) return {xItems: [], yVariants: []};

  const query = `#graphql
    query GetResources($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          featuredMedia {
            preview {
              image {
                url(transform: {maxWidth: 80, maxHeight: 80})
              }
            }
          }
        }
        ... on ProductVariant {
          id
          title
          displayName
          media(first: 1) {
            nodes {
              preview {
                image {
                  url(transform: {maxWidth: 80, maxHeight: 80})
                }
              }
            }
          }
          product {
            id
            title
            featuredMedia {
              preview {
                image {
                  url(transform: {maxWidth: 80, maxHeight: 80})
                }
              }
            }
          }
        }
      }
    }
  `;
  const result = await adminApiQuery(query, {variables: {ids}});
  const nodes = new Map(
    (result?.data?.nodes ?? []).filter(Boolean).map(node => [node.id, node]),
  );

  // Resources deleted since the discount was saved are dropped.
  const xItems = config.xItems.flatMap(item => {
    const node = nodes.get(item.id);
    if (!node) return [];
    return item.type === "product"
      ? [
          {
            type: "product",
            id: node.id,
            productId: node.id,
            title: node.title,
            image: productImage(node),
          },
        ]
      : [
          {
            type: "variant",
            id: node.id,
            productId: node.product.id,
            title: variantTitle(node),
            image: variantImage(node),
          },
        ];
  });
  const yVariants = config.yVariantIds.flatMap(id => {
    const node = nodes.get(id);
    return node
      ? [
          {
            id: node.id,
            productId: node.product.id,
            title: variantTitle(node),
            image: variantImage(node),
          },
        ]
      : [];
  });
  return {xItems, yVariants};
}

function productImage(product) {
  return product?.featuredMedia?.preview?.image?.url ?? null;
}

function variantImage(variant) {
  return (
    variant.media?.nodes?.[0]?.preview?.image?.url ??
    productImage(variant.product)
  );
}

function serializeIds(items) {
  return items.map(({id}) => id).join(",");
}

// Variants ticked in a product picker selection. A product picked without
// ticked variants contributes all of its variants.
async function selectedVariantIds(selection, adminApiQuery) {
  const ids = [];
  const productsWithoutVariants = [];
  for (const product of selection) {
    const variants = product.variants ?? [];
    if (variants.length) {
      ids.push(...variants.map(({id}) => id));
    } else {
      productsWithoutVariants.push(product.id);
    }
  }
  if (productsWithoutVariants.length) {
    const query = `#graphql
      query GetProductVariantIds($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            variants(first: 250) {
              nodes {
                id
              }
            }
          }
        }
      }
    `;
    const result = await adminApiQuery(query, {
      variables: {ids: productsWithoutVariants},
    });
    for (const node of result?.data?.nodes ?? []) {
      ids.push(...(node?.variants?.nodes ?? []).map(({id}) => id));
    }
  }
  return [...new Set(ids)];
}

// Single-variant products have a "Default Title" variant, so show the
// product title alone for those.
function variantTitle(variant) {
  const productTitle = variant.product?.title ?? "";
  if (!variant.title || variant.title === "Default Title") {
    return productTitle || variant.displayName;
  }
  return productTitle
    ? `${productTitle} - ${variant.title}`
    : variant.displayName;
}

async function saveStorefrontRule(configuration, discountId, adminApiQuery) {
  const liveRuleIds = await getLiveRuleIds(adminApiQuery);

  // Retried when another save changed the rules between our read and write.
  for (let attempt = 0; attempt < 3; attempt++) {
    const {installationId, rules, compareDigest} =
      await readStorefrontRules(adminApiQuery);

    // Drop rules whose discount has been deleted. Skipped if the lookup
    // failed, so a transient error never wipes live rules.
    if (liveRuleIds) {
      for (const id of Object.keys(rules)) {
        if (!liveRuleIds.has(id)) delete rules[id];
      }
    }
    rules[configuration.ruleId] = {
      discountId: discountId || null,
      xItems: configuration.xItems.map(({type, id}) => ({type, id})),
      yVariantIds: configuration.yVariantIds,
      usesPerOrder: configuration.maxUsesPerOrder,
    };

    const userErrors = await writeStorefrontRules(
      installationId,
      rules,
      compareDigest,
      adminApiQuery,
    );
    if (!userErrors.length) return;
    if (!userErrors.every(({code}) => code === "STALE_OBJECT")) {
      throw new Error(userErrors.map(({message}) => message).join(" "));
    }
  }
  throw new Error("The storefront rules were changed by another save.");
}

async function readStorefrontRules(adminApiQuery) {
  const query = `#graphql
    query GetStorefrontRules($namespace: String!, $key: String!) {
      currentAppInstallation {
        id
        metafield(namespace: $namespace, key: $key) {
          value
          compareDigest
        }
      }
    }
  `;
  const result = await adminApiQuery(query, {
    variables: {namespace: STOREFRONT_NAMESPACE, key: STOREFRONT_KEY},
  });
  const installation = result?.data?.currentAppInstallation;
  if (!installation) {
    throw new Error("Unable to read the app installation");
  }

  let rules = {};
  try {
    rules = JSON.parse(installation.metafield?.value || "{}");
  } catch {
    rules = {};
  }
  return {
    installationId: installation.id,
    rules,
    compareDigest: installation.metafield?.compareDigest ?? null,
  };
}

async function writeStorefrontRules(
  installationId,
  rules,
  compareDigest,
  adminApiQuery,
) {
  const query = `#graphql
    mutation SetStorefrontRules($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors {
          field
          message
          code
        }
      }
    }
  `;
  const result = await adminApiQuery(query, {
    variables: {
      metafields: [
        {
          ownerId: installationId,
          namespace: STOREFRONT_NAMESPACE,
          key: STOREFRONT_KEY,
          type: "json",
          value: JSON.stringify(rules),
          compareDigest,
        },
      ],
    },
  });
  if (result?.errors?.length) {
    throw new Error(result.errors.map(({message}) => message).join(" "));
  }
  return result?.data?.metafieldsSet?.userErrors ?? [];
}

// Rule IDs of every discount of this type that still exists, or null if the
// lookup failed.
async function getLiveRuleIds(adminApiQuery) {
  const query = `#graphql
    query GetLiveRuleIds($after: String) {
      discountNodes(first: 250, after: $after, query: "type:app") {
        nodes {
          metafield(
            namespace: "buy-x-range-get-y"
            key: "function-configuration"
          ) {
            jsonValue
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
  try {
    const ids = new Set();
    let after = null;
    do {
      const result = await adminApiQuery(query, {variables: {after}});
      const connection = result?.data?.discountNodes;
      if (result?.errors?.length || !connection) return null;
      for (const node of connection.nodes) {
        const id = node.metafield?.jsonValue?.ruleId;
        if (id) ids.add(id);
      }
      after = connection.pageInfo.hasNextPage
        ? connection.pageInfo.endCursor
        : null;
    } while (after);
    return ids;
  } catch {
    return null;
  }
}
