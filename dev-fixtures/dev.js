// Local dev harness.
//
// Drives the production renderPlans() path with mock PlanRefs backed by
// fixture files. Toggle ?single=1 to exercise the single-plan path (selector
// hidden) — useful to confirm the multi-plan changes don't regress the simple
// case.

(function () {
    var FIXTURES = [
        { name: 'staging', file: 'sample-plan.json' },
        { name: 'prod-no-changes', file: 'sample-plan-no-changes.json' },
    ];

    var params = new URLSearchParams(window.location.search);
    var refs = params.get('single') === '1' ? FIXTURES.slice(0, 1) : FIXTURES;

    // PlanRef shape mirrors tab.ts. Fields other than `name` are unused by
    // the dev fetcher — they exist only to satisfy the production type.
    var planRefs = refs.map(function (f) {
        return {
            name: f.name,
            projectId: 'dev',
            buildId: 0,
            timelineId: 'dev',
            recordId: 'dev',
            __file: f.file,
        };
    });

    // ?slow=N pads each fetch by N ms so the loading skeleton is visible long
    // enough to inspect / screenshot. No effect in production (different fetcher).
    var slowMs = parseInt(params.get('slow') || '0', 10) || 0;

    function devFetcher(ref) {
        var fetchP = fetch(ref.__file + '?_=' + Date.now()).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' loading ' + ref.__file);
            return r.json();
        });
        if (slowMs <= 0) return fetchP;
        return fetchP.then(function (plan) {
            return new Promise(function (resolve) { setTimeout(function () { resolve(plan); }, slowMs); });
        });
    }

    var container = document.getElementById('container');
    window.TerraformPlanViewer.renderPlans(planRefs, devFetcher, container);
})();
