// Minimal type definitions for the Azure DevOps legacy VSS Extension SDK.
// Only the surface used by this extension is declared.

declare namespace VSS {
    interface InitOptions {
        explicitNotifyLoaded?: boolean;
        usePlatformStyles?: boolean;
        applyTheme?: boolean;
    }

    interface SessionToken {
        token: string;
    }

    interface WebContext {
        project: { id: string; name: string };
        collection: { uri: string };
    }

    interface BuildContext {
        id: number;
        result?: string;
        status?: string;
    }

    interface BuildResultsConfiguration {
        buildId?: number;
        onBuildChanged?: (callback: (build: BuildContext) => void) => void;
    }

    function init(options: InitOptions): void;
    function ready(callback: () => void): void;
    function notifyLoadSucceeded(): void;
    function notifyLoadFailed(error: string): void;
    function getWebContext(): WebContext;
    function getConfiguration(): BuildResultsConfiguration;
    function getAccessToken(): Promise<SessionToken>;
}
