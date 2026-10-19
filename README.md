# GitCode PR Dashboard: All Pages + Labels + Repositories

Tampermonkey userscript for the GitCode pull request dashboard.

## Features

- Requests every page for the selected status in the background (`per_page=100`).
- Replaces the paged list with the complete live result set and hides native pagination.
- Shows every label found in the full result set with its PR count, in a dedicated full-width row below the native status tabs.
- Each label and repository button cycles through **Neutral → Include → Exclude → Neutral**, with visible symbols (`○`, `+`, `−`), distinct colors, and an accessible state description. Each row's clear action removes both include and exclude selections.
- Included labels use AND; excluded labels must all be absent. Included repositories use OR (none selected means all); excluded repositories are always removed. The two dimensions are combined using AND.
- Shows repositories by full namespace/path in a dedicated row below labels.
- Live badges show **→ N**, the final number of PRs after the button's next click, considering every include/exclude condition in both dimensions. The header shows the current final matching count and total loaded count; tooltips also show each option's unfiltered count.
- Zero-result buttons remain clickable so they can reach the exclusion state. Options retain their order, focus, and scroll as selections change. During loading, counts show a dash, existing conditions can still be cycled or cleared, and new conditions/export are disabled.
- Follows the actual GitCode page background for light/dark palettes, with separate include/exclude colors, readable text/borders, and keyboard focus styles. It responds to site theme changes and uses the system preference only as a fallback.
- The full option set remains visible. Label keys are case-insensitive and each PR is counted once per label. Conditions absent from a newly loaded result set are removed.
- Exports the complete currently label- and repository-filtered list as a JSON array, including PR links; export stays disabled until loading finishes.
- Keeps the current GitCode search, scope, sort, and status parameters.
- Rechecks the first page and total before rendering; if the dataset changes or a request fails, the native paginated view is restored.

## Installation

1. Install Tampermonkey.
2. Open the raw userscript: <https://raw.githubusercontent.com/KaranocaVe/gitcode-pr-dashboard-all-labels-userscript/main/gitcode-pr-dashboard-all-labels.user.js>
3. Install or update the script.
4. Disable any previously installed separate pagination and label-filter scripts so only the combined script runs.
5. Open <https://gitcode.com/dashboard/pulls> and refresh the page. The loading status includes the installed script version (currently `v1.6.0`).

The script uses the existing GitCode login session in the page. It does not store or log the access token.

## License

MIT
