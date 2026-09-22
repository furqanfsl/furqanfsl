# Profile analytics

The profile embeds committed SVGs rather than requesting the public stats and
activity-graph servers on every page view. Those servers were returning Vercel
`DEPLOYMENT_PAUSED` (503) and `DEPLOYMENT_DISABLED` (402) responses.

The **Update profile analytics** workflow refreshes the images daily at 03:37 UTC.
It can also be run manually from the repository's Actions tab. GitHub may delay
scheduled runs and disable schedules after 60 days of repository inactivity.
If needed, re-enable the workflow in the Actions tab. If a refresh fails, the last successfully committed images stay
visible. No personal access token or external deployment is required.

- `stats.svg` and `top-langs.svg` use the upstream GitHub Readme Stats Action,
  pinned to a reviewed commit with GitHub Stats Extended 2.2.0.
- `activity.svg` and its compact `activity-mobile.svg` variant plot the last 31 UTC calendar days from GitHub's contribution
  calendar, including today. The current day can be incomplete.
- The workflow uses the repository-scoped `GITHUB_TOKEN`, not a personal token
  with access to private repositories. Counts can differ from a signed-in view
  of your profile and from services with different date ranges or caches.
- The existing live streak card and contribution-snake workflow are unchanged.
  Analytics stay on `main`, separate from the snake's `output` branch.

## Local checks

Requires Node.js 24. No npm dependencies are needed for the activity graph.

```sh
node --test scripts/activity-graph.test.mjs
```

To refresh the activity graph locally, provide `GITHUB_TOKEN` and `GH_USERNAME`
as environment variables and run `node scripts/activity-graph.mjs` from the
repository root. Never commit a token. Use the GitHub workflow to refresh all
images together.

Upstream guidance:
- https://github.com/stats-organization/github-readme-stats-action
- https://github.com/anuraghazra/github-readme-stats#github-actions
