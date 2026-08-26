/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'packages-must-not-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'domain-must-remain-pure',
      severity: 'error',
      from: { path: '^packages/domain/' },
      to: {
        path: '^(apps/|packages/(database|messaging|object-storage|observability|providers-|security|health)/|node_modules/)',
      },
    },
    {
      name: 'web-must-not-import-server-infrastructure',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: {
        path: '^packages/(database|messaging|object-storage|providers-github|security)/',
      },
    },
    {
      name: 'api-must-not-import-other-apps',
      severity: 'error',
      from: { path: '^apps/api/' },
      to: { path: '^apps/(web|worker|sandbox-runner)/' },
    },
    {
      name: 'web-must-not-import-other-apps',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^apps/(api|worker|sandbox-runner)/' },
    },
    {
      name: 'worker-must-not-import-other-apps',
      severity: 'error',
      from: { path: '^apps/worker/' },
      to: { path: '^apps/(api|web|sandbox-runner)/' },
    },
    {
      name: 'sandbox-must-not-import-other-apps',
      severity: 'error',
      from: { path: '^apps/sandbox-runner/' },
      to: { path: '^apps/(api|web|worker)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
    },
    exclude: '(^|/)dist/|(^|/)coverage/',
    includeOnly: '^(apps|packages)/',
    tsConfig: { fileName: 'tsconfig.base.json' },
  },
};
