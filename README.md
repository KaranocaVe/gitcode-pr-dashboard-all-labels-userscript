# GitCode PR Dashboard: All Pages + Labels + Repositories

Tampermonkey userscript for the GitCode pull request dashboard.

## Features

- Requests every page for the selected status in the background (`per_page=100`).
- Replaces the paged list with the complete live result set and hides native pagination.
- Shows every label found in the full result set with its PR count, in a dedicated full-width row below the native status tabs.
- Supports multi-label AND filtering and a one-click clear action.
- Shows target repositories by full namespace/path with PR counts in a separate row below labels.
- Supports multi-repository OR filtering; repository selections are combined with label selections using AND. With no repository selected, all repositories are included. Each row has its own clear action.
- Counts are based on the complete result set for the current GitCode query and status, before local label/repository filters. Selections absent from a newly loaded result set are removed.
- Exports the complete currently label- and repository-filtered list as a JSON array, including PR links; export stays disabled until loading finishes.
- Keeps the current GitCode search, scope, sort, and status parameters.
- Rechecks the first page and total before rendering; if the dataset changes or a request fails, the native paginated view is restored.

## Installation

1. Install Tampermonkey.
2. Open the raw userscript: <https://raw.githubusercontent.com/KaranocaVe/gitcode-pr-dashboard-all-labels-userscript/main/gitcode-pr-dashboard-all-labels.user.js>
3. Install or update the script.
4. Disable any previously installed separate pagination and label-filter scripts so only the combined script runs.
5. Open <https://gitcode.com/dashboard/pulls> and refresh the page. The loading status includes the installed script version (currently `v1.4.0`).

The script uses the existing GitCode login session in the page. It does not store or log the access token.

## License

MIT
