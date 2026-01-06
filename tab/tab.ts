// Initialize the Azure DevOps SDK
VSS.init({
    explicitNotifyLoaded: true,
    usePlatformStyles: true
});

VSS.ready(function() {
    // Get the Web Context
    const webContext = VSS.getWebContext();
    
    // Get build/release information
    const buildId = webContext.build?.id;
    const projectId = webContext.project.id;
    const collectionUri = webContext.collection.uri;
    
    console.log('Build ID:', buildId);
    console.log('Project ID:', projectId);
    
    // Load the plan report
    loadPlanReport(collectionUri, projectId, buildId);
    
    // Notify that the extension is loaded
    VSS.notifyLoadSucceeded();
});

async function loadPlanReport(collectionUri: string, projectId: string, buildId: number) {
    const container = document.getElementById('container');
    
    if (!container) {
        return;
    }
    
    try {
        // Get the build service
        const buildService = await VSS.getService<any>(VSS.ServiceIds.Build);
        
        // Get attachments for the build of type Distributedtask.Core.Summary
        // This matches the attachment type created by the TerraformPlanViewer task
        const attachments = await buildService.getAttachments(projectId, buildId, 'Distributedtask.Core.Summary');
        
        console.log('Attachments:', attachments);
        
        // Find the terraform plan attachment by exact name match first, then fallback to partial match
        // Default attachment name is 'terraform-plan' but can be customized in task inputs
        const planAttachment = attachments.find((a: any) => 
            a.name === 'terraform-plan'
        ) || attachments.find((a: any) => 
            a.name && a.name.toLowerCase().includes('terraform')
        );
        
        if (!planAttachment) {
            showError('Terraform plan report not found', 
                'Make sure the Terraform Plan Viewer task has been executed in this pipeline.');
            return;
        }
        
        // Get the attachment content URL
        // The attachment recordsUri or contentUrl should be used to fetch the actual content
        const attachmentUrl = planAttachment.recordsUri || planAttachment._links?.self?.href;
        
        console.log('Loading report from:', attachmentUrl);
        
        // Load the content via REST API
        const token = await VSS.getAccessToken();
        
        // Fetch the attachment content
        const response = await fetch(attachmentUrl, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to load report: ${response.statusText}`);
        }
        
        const htmlContent = await response.text();
        
        // Display the HTML content in an iframe
        const iframe = document.createElement('iframe');
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        
        container.innerHTML = '';
        container.appendChild(iframe);
        
        // Write the content to the iframe
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) {
            iframeDoc.open();
            iframeDoc.write(htmlContent);
            iframeDoc.close();
        }
        
    } catch (error) {
        console.error('Error loading plan report:', error);
        showError('Failed to load Terraform plan', 
            error instanceof Error ? error.message : 'An unknown error occurred');
    }
}

function showError(title: string, message: string) {
    const container = document.getElementById('container');
    if (container) {
        container.innerHTML = `
            <div class="error">
                <div class="error-title">${title}</div>
                <div class="error-message">${message}</div>
            </div>
        `;
    }
}
