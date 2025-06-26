const fs = require('fs');
const path = require('path');

// Error Monitor CDN Script (as string to inject)
const errorMonitorScript = `
(function() {
  'use strict';
  
  // Prevent multiple initializations
  if (window.__errorMonitorInitialized) {
    console.log('Error monitor already initialized');
    return;
  }
  window.__errorMonitorInitialized = true;

  function sendToWebhook(data) {
    console.log("Send to webhook", data);
    try {
      if (window.parent && window !== window.parent) {
        window.parent.postMessage(
          {
            source: "superengineer",
            ...data
          },
          "*"
        );
      } else {
        console.warn("Parent window not available for postMessage.");
      }
    } catch (err) {
      console.error("Failed to send message to parent:", err);
    }
  }

  function waitForHeaderElement(shadow, retries = 10, delay = 200) {
    return new Promise((resolve) => {
      const check = (count) => {
        const el = shadow.querySelector('div');
        if (el || count <= 0) {
          resolve(el);
        } else {
          setTimeout(() => check(count - 1), delay);
        }
      };
      check(retries);
    });
  }

  // Helper function for message formatting
  function formatMessageWithPlaceholders(template, ...args) {
    if (typeof template !== "string") {
      return [template, ...args].map(String).join(" ");
    }

    let i = 0;
    const formatted = template.replace(/%([sidfoOc])/g, (_match, type) => {
      const arg = args[i++];
      switch (type) {
        case "s": return String(arg);
        case "i":
        case "d": return parseInt(arg).toString();
        case "f": return parseFloat(arg).toString();
        case "o":
        case "O":
          try { return JSON.stringify(arg); } catch { return String(arg); }
        default: return _match;
      }
    });

    const remainingArgs = args.slice(i).map(arg => {
      if (typeof arg === "object") {
        try {
          return arg?.message ?? JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    });

    return formatted + (remainingArgs.length > 0 ? " " + remainingArgs.join(" ") : "");
  }

  function initEnhancedErrorMonitor(options = {}) {
    const isServer = false;
    
    if (typeof window === 'undefined') return {};
    
    let isInitialized = false;
    let originalConsole = null;
    let lastErrorHash = '';
    
    console.log("🔍 [EnhancedErrorMonitor] Initializing...");
    
    async function checkDomErrors() {
      console.log("Checking for Next.js errors in DOM");
      
      const portals = document.querySelectorAll('nextjs-portal');
      let foundError = false;
      
      for (const portal of portals) {
        const shadow = portal.shadowRoot;
        
        if (!shadow) continue;
        
        try {
          const header = await waitForHeaderElement(shadow);
          
          if (header) {
            const serializer = new XMLSerializer();
            const htmlString = serializer.serializeToString(header);
            
            console.log("Found potential Next.js error element");
            foundError = true;
            
            await sendToWebhook({
              type: "dom",
              dom: htmlString,
              timestamp: new Date().toISOString()
            });
            
            console.log("DOM error sent to webhook");
            return true;
          }
        } catch (error) {
          console.error("Error checking DOM for errors:", error);
        }
      }
      
      return foundError;
    }
    
    async function handleConsoleError(method, message, args) {
      console.log(\`Handling \${method} message:\`, message);
      
      if (method !== "error") return;
      
      const domErrorFound = await checkDomErrors();
      
      if (!domErrorFound) {
        console.log("No DOM error found, sending console error");
        
        sendToWebhook({
          type: "console",
          method,
          message,
          args: JSON.stringify(args.map(arg => {
            try {
              return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
            } catch (e) {
              return String(arg);
            }
          })),
          isServer,
          timestamp: new Date().toISOString()
        });
      } else {
        console.log("DOM error found and sent, skipping console error");
      }
    }
    
    function setupConsoleInterceptors() {
      if (isInitialized) return;
      
      console.log("Setting up console interceptors");
      
      originalConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
        debug: console.debug
      };
      
      console.error = function (...args) {
        try {
          const formatted = typeof formatMessageWithPlaceholders === 'function' 
            ? formatMessageWithPlaceholders(args[0], ...args.slice(1))
            : args.map(arg => String(arg)).join(' ');
            
          const errorHash = \`console-error-\${formatted.substring(0, 100)}\`;
          
          if (errorHash !== lastErrorHash) {
            lastErrorHash = errorHash;
            handleConsoleError("error", formatted, args);
          }
        } catch (formatErr) {
          console.log("Error in console error interceptor:", formatErr);
        }
        
        originalConsole.error(...args);
      };
    }
    
    function setupErrorHandlers() {
      console.log("Setting up error handlers");
      
      window.onerror = (msg, src, line, col, err) => {
        console.log("onerror triggered:", msg);
        console.error(\`Uncaught error: \${String(msg)}\`, err);
        return false;
      };
      
      window.onunhandledrejection = event => {
        console.log("onunhandledrejection triggered:", event.reason);
        console.error(\`Unhandled promise rejection: \${String(event.reason?.message || event.reason)}\`, event.reason);
      };
    }
    
    function setupNextJsErrorObserver() {
      console.log("Setting up Next.js error observer");
      
      const observer = new MutationObserver((mutations) => {
        let shouldCheck = false;
        
        for (const mutation of mutations) {
          if (mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (node.nodeName && 
                  (node.nodeName.toLowerCase() === 'nextjs-portal' || 
                   node.shadowRoot || 
                   node.querySelector?.('nextjs-portal'))) {
                shouldCheck = true;
                break;
              }
            }
          }
          
          if (!shouldCheck && 
              mutation.type === 'attributes' && 
              mutation.target.nodeName && 
              mutation.target.nodeName.toLowerCase() === 'nextjs-portal') {
            shouldCheck = true;
          }
          
          if (shouldCheck) break;
        }
        
        if (shouldCheck) {
          console.log("Relevant DOM mutation detected, checking for Next.js errors");
          checkDomErrors();
        }
      });
      
      observer.observe(document.body, { 
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
      });
      
      return observer;
    }
    
    function initialize() {
      if (isInitialized) return;
      isInitialized = true;
      
      setupConsoleInterceptors();
      setupErrorHandlers();
      const observer = setupNextJsErrorObserver();
      
      checkDomErrors();
      
      const cleanup = () => {
        console.log("Cleaning up error monitor");
        
        if (originalConsole) {
          console.error = originalConsole.error;
        }
        
        window.onerror = null;
        window.onunhandledrejection = null;
        observer.disconnect();
        
        isInitialized = false;
        originalConsole = null;
      };
      
      window.__cleanupErrorMonitor = cleanup;
      return cleanup;
    }
    
    function sendErrorManually(error) {
      if (typeof window === 'undefined') {
        return false;
      }
      
      try {
        const message = error?.message || String(error);
        return handleConsoleError("error", message, [error]);
      } catch (err) {
        console.log("Failed to manually send error:", err);
        return false;
      }
    }
    
    initialize();
    
    return {
      sendError: sendErrorManually,
      checkForErrors: checkDomErrors,
      cleanup: () => window.__cleanupErrorMonitor?.()
    };
  }

  function initWhenReady() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        window.__errorMonitorAPI = initEnhancedErrorMonitor({
          debug: true,
          debounceTime: 0,
          domCheckDelay: 0
        });
      });
    } else {
      window.__errorMonitorAPI = initEnhancedErrorMonitor({
        debug: true,
        debounceTime: 0,
        domCheckDelay: 0
      });
    }
  }

  initWhenReady();
  window.__initErrorMonitor = initEnhancedErrorMonitor;

})();
`;

try {
    // Create the error monitor script file
    const errorMonitorPath = path.join(__dirname, 'error-monitor.js');
    fs.writeFileSync(errorMonitorPath, errorMonitorScript);
    console.log('✅ error-monitor.js created successfully');

    // Path to your Next.js app
    const appPath = path.join(__dirname, '../app/apps/current_session');
    
    // Check if app directory exists
    if (!fs.existsSync(appPath)) {
        console.error('❌ App directory not found:', appPath);
        console.log('Please update the appPath variable to point to your Next.js app directory');
        process.exit(1);
    }

    // Copy error monitor to app folder (optional, for local serving)
    const appErrorMonitorPath = path.join(appPath, 'public', 'error-monitor.js');
    
    // Create public directory if it doesn't exist
    const publicDir = path.dirname(appErrorMonitorPath);
    if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true });
    }
    
    fs.copyFileSync(errorMonitorPath, appErrorMonitorPath);
    console.log('✅ error-monitor.js copied to app/public folder');

    // Update layout.tsx
    const layoutPath = path.join(appPath, 'app', 'layout.tsx');
    
    if (fs.existsSync(layoutPath)) {
        let layoutContent = fs.readFileSync(layoutPath, 'utf8');
        
        // Check if error monitor is already added
        if (layoutContent.includes('error-monitor.js')) {
            console.log('⚠️  Error monitor already exists in layout.tsx');
        } else {
            // Add error monitor configuration
            const errorMonitorConfig = `
// Error Monitor Configuration
const useLocalErrorMonitor = true; // Set to false for CDN
const errorMonitorSrc = useLocalErrorMonitor
    ? '/error-monitor.js' // Served from public folder
    : 'https://your-cdn-domain.com/error-monitor.js'; // Replace with your CDN URL
`;

            // Add the script tag
            const scriptTag = `                
                {/* Error Monitor - Load early to catch all errors */}
                <Script
                    src={errorMonitorSrc}
                    strategy="beforeInteractive"
                    crossOrigin="anonymous"
                />`;

            // Insert configuration after existing constants
            layoutContent = layoutContent.replace(
                /(const isProd = process\.env\.NODE_ENV === 'production';)/,
                `$1\n${errorMonitorConfig}`
            );

            // Insert script tag before closing </head>
            layoutContent = layoutContent.replace(
                /(\s+)(<\/head>)/,
                `$1${scriptTag}\n$1$2`
            );

            fs.writeFileSync(layoutPath, layoutContent);
            console.log('✅ layout.tsx updated with error monitor');
        }
    } else {
        console.log('⚠️  layout.tsx not found at:', layoutPath);
        console.log('Please manually add the error monitor script to your layout file');
    }

    console.log('\n🎉 Setup complete!');
    console.log('\nNext steps:');
    console.log('1. Your error monitor is now available at /error-monitor.js');
    console.log('2. Start your Next.js app to test error monitoring');
    console.log('3. For production, upload error-monitor.js to a CDN and update the URL in layout.tsx');

} catch (error) {
    console.error('❌ Error in inject.js:', error);
    process.exit(1);
}