// Local dev harness.
//
// Drives the production renderPlans() path with mock PlanRefs backed by
// fixture files. Toggle ?single=1 to exercise the single-plan path (selector
// hidden) — useful to confirm the multi-plan changes don't regress the simple
// case. ?hide=1 simulates the task's hideNoChangePlans input.
// ?scenario=edge loads overview edge cases (duplicate attachment names,
// an output-only plan) without changing the default screenshot set.

(function () {
    var ALL_FIXTURES = [
        { name: 'prod-apps-aks-cluster-weu', file: 'sample-plan-aks.json' },
        { name: 'prod-apps-sql-primary', file: 'sample-plan-no-changes.json' },
        { name: 'prod-platform-dns-private-zones', file: 'sample-plan-no-changes.json' },
        { name: 'prod-platform-network-hub-vnet', file: 'sample-plan-hub-vnet.json' },
        { name: 'shared-monitoring', file: 'sample-plan-no-changes.json' },
        { name: 'staging', file: 'sample-plan.json' },
    ];

    // Two jobs publishing the same attachment name are told apart by recordId.
    var EDGE_FIXTURES = [
        { name: 'prod', file: 'sample-plan.json', recordId: 'abcd1234-0000-0000-0000-000000000001' },
        { name: 'prod', file: 'sample-plan.json', recordId: 'ef567890-0000-0000-0000-000000000002' },
        { name: 'outputs', file: 'sample-plan-outputs-only.json' },
        { name: 'quiet', file: 'sample-plan-no-changes.json' },
    ];

    var params = new URLSearchParams(window.location.search);
    var refs = params.get('single') === '1'
        ? [{ name: 'staging', file: 'sample-plan.json' }]
        : params.get('scenario') === 'edge' ? EDGE_FIXTURES : ALL_FIXTURES;

    // PlanRef shape mirrors tab.ts. Fields other than `name` are unused by
    // the dev fetcher — they exist only to satisfy the production type.
    var planRefs = refs.map(function (f) {
        return {
            name: f.name,
            projectId: 'dev',
            buildId: 0,
            timelineId: 'dev',
            recordId: f.recordId || 'dev',
            __file: f.file,
        };
    });

    // ?hide=1 simulates the task's hideNoChangePlans input on every plan.
    var simulateHide = params.get('hide') === '1';

    // ?slow=N pads each fetch by N ms so the loading skeleton is visible long
    // enough to inspect / screenshot. No effect in production (different fetcher).
    var slowMs = Number.parseInt(params.get('slow') || '0', 10) || 0;

    function devFetcher(ref) {
        // `plan` / `record` let browser tests hold or release one plan's download.
        var url = ref.__file + '?_=' + Date.now()
            + '&plan=' + encodeURIComponent(ref.name)
            + '&record=' + encodeURIComponent(ref.recordId);
        var fetchP = fetch(url).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' loading ' + ref.__file);
            return r.json();
        }).then(function (plan) {
            if (simulateHide) plan.terraform_plan_viewer = { hideNoChangePlans: true };
            return plan;
        });
        if (slowMs <= 0) return fetchP;
        return fetchP.then(function (plan) {
            return new Promise(function (resolve) { setTimeout(function () { resolve(plan); }, slowMs); });
        });
    }

    var container = document.getElementById('container');
    var renderP = window.TerraformPlanViewer.renderPlans(planRefs, devFetcher, container);
    // Overview fetches continue in the background; wait briefly so ?shot=1
    // screenshots capture filled-in counts rather than "Loading…".
    Promise.resolve(renderP).then(function () {
        setTimeout(function () { document.documentElement.dataset.ready = '1'; }, 400);
    });
})();
