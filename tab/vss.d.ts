// Type definitions for Azure DevOps Extension SDK
declare namespace VSS {
    function init(options: any): void;
    function ready(callback: () => void): void;
    function getWebContext(): any;
    function notifyLoadSucceeded(): void;
    function getService<T>(serviceId: string): Promise<T>;
    function getAccessToken(): Promise<string>;
    
    namespace ServiceIds {
        const Build: string;
    }
}
