# GitCode PR Dashboard: All Pages + Labels

Tampermonkey userscript for the GitCode pull request dashboard.

## Features

- Requests every page for the selected status in the background (`per_page=100`).
- Replaces the paged list with the complete live result set and hides native pagination.
- Shows every label found in the full result set with its PR count.
- Supports multi-label AND filtering and a one-click clear action.
- Keeps the current GitCode search, scope, sort, and status parameters.
- Rechecks the first page and total before rendering; if the dataset changes or a request fails, the native paginated view is restored.

## Installation

1. Install Tampermonkey.
2. Open the raw userscript: <https://raw.githubusercontent.com/KaranocaVe/gitcode-pr-dashboard-all-labels-userscript/main/gitcode-pr-dashboard-all-labels.user.js>
3. Install or update the script.
4. Open <https://gitcode.com/dashboard/pulls>.

The script uses the existing GitCode login session in the page. It does not store or log the access token.

## License

MIT
