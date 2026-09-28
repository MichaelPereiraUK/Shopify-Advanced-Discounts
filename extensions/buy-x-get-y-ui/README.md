# Buy X range, get Y: settings UI

Admin UI extension for the `admin.discount-details.function-settings.render` target. It renders the "Buy X range, get Y" settings on the discount details page. Shopify's own discount page handles active dates, eligibility, combinations and usage limits.

It saves two things:

- `buy-x-range-get-y` / `function-configuration` on the discount. This is read by the `buy-x-get-y` function.
- `$app:bxgy` / `rules` on the app installation. This is read by the `buy-x-get-y-embed` theme app embed to auto-add Y.
