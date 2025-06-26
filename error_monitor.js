// Enhanced Error Monitor - CDN Version
// This should be served as a standalone JavaScript file

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

  /**
   * Enhanced Error Monitor that combines console logging interception with
   * Next.js error detection in the DOM
   */
  function initEnhancedErrorMonitor(options = {}) {
    const isServer = false;
    
    if (typeof window === 'undefined') return {};
    
    let isInitialized = false;
    let originalConsole = null;
    
    // For tracking to avoid duplicates
    let lastErrorHash = '';
    
    console.log("🔍 [EnhancedErrorMonitor] Initializing...");
    
    /**
     * Check for Next.js errors in DOM
     */
    async function checkDomErrors() {
      console.log("Checking for Next.js errors in DOM");
      
      const portals = document.querySelectorAll('nextjs-portal');
      let foundError = false;
      
      // Use for...of instead of forEach for async operations
      for (const portal of portals) {
        const shadow = portal.shadowRoot;
        
        if (!shadow) continue;
        
        try {
          const header = await waitForHeaderElement(shadow);
          
          if (header) {
            // Serialize the DOM element for inspection
            const serializer = new XMLSerializer();
            const htmlString = serializer.serializeToString(header);
            
            // Found a potential error in the DOM
            console.log("Found potential Next.js error element");
            foundError = true;
            
            // Send DOM error to webhook
            await sendToWebhook({
              type: "dom",
              dom: htmlString,
              timestamp: new Date().toISOString()
            });
            
            console.log("DOM error sent to webhook");
            return true; // Error found and sent
          }
        } catch (error) {
          console.error("Error checking DOM for errors:", error);
        }
      }
      
      return foundError;
    }
    
    /**
     * Handle console errors according to the specified flow:
     * 1. Listen to console error
     * 2. If found console error, check for DOM error
     * 3. If found DOM error, send the DOM error
     * 4. Else, send the console error
     */
    async function handleConsoleError(method, message, args) {
      console.log(`Handling ${method} message:`, message);
      
      // Skip non-error messages
      if (method !== "error") return;
      
      // Check for DOM errors first
      const domErrorFound = await checkDomErrors();
      
      // If no DOM error was found, send the console error
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
    
    /**
     * Set up console interceptors
     */
    function setupConsoleInterceptors() {
      if (isInitialized) return;
      
      console.log("Setting up console interceptors");
      
      // Store original console methods
      originalConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
        debug: console.debug
      };
      
      // Only intercept errors as per requested flow
      console.error = function (...args) {
        try {
          const formatted = typeof formatMessageWithPlaceholders === 'function' 
            ? formatMessageWithPlaceholders(args[0], ...args.slice(1))
            : args.map(arg => String(arg)).join(' ');
            
          // Create quick hash to avoid duplicates
          const errorHash = `console-error-${formatted.substring(0, 100)}`;
          
          if (errorHash !== lastErrorHash) {
            lastErrorHash = errorHash;
            handleConsoleError("error", formatted, args);
          }
        } catch (formatErr) {
          console.log("Error in console error interceptor:", formatErr);
        }
        
        // Always call original method
        originalConsole.error(...args);
      };
    }
    
    /**
     * Set up error event handlers
     */
    function setupErrorHandlers() {
      console.log("Setting up error handlers");
      
      // Catch uncaught errors
      window.onerror = (msg, src, line, col, err) => {
        console.log("onerror triggered:", msg);
        
        // This will trigger our console.error handler which follows the flow
        console.error(`Uncaught error: ${String(msg)}`, err);
        
        return false; // Let error propagate normally
      };
      
      // Catch unhandled promise rejections
      window.onunhandledrejection = event => {
        console.log("onunhandledrejection triggered:", event.reason);
        
        // This will trigger our console.error handler which follows the flow
        console.error(`Unhandled promise rejection: ${String(event.reason?.message || event.reason)}`, event.reason);
      };
    }
    
    /**
     * Set up efficient DOM observer for Next.js errors
     */
    function setupNextJsErrorObserver() {
      console.log("Setting up Next.js error observer");
      
      const observer = new MutationObserver((mutations) => {
        let shouldCheck = false;
        
        // Only process if we see relevant mutations
        for (const mutation of mutations) {
          // Look for nextjs-portal elements or shadow DOM changes
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
          
          // Also check attribute changes that might indicate error state
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
      
      // More targeted observation - only watch for portal elements and their attributes
      observer.observe(document.body, { 
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
      });
      
      return observer;
    }
    
    /**
     * Initialize everything
     */
    function initialize() {
      if (isInitialized) return;
      isInitialized = true;
      
      setupConsoleInterceptors();
      setupErrorHandlers();
      const observer = setupNextJsErrorObserver();
      
      // Initial check for any existing errors
      checkDomErrors();
      
      // Cleanup function - expose globally if needed
      const cleanup = () => {
        console.log("Cleaning up error monitor");
        
        // Restore console
        if (originalConsole) {
          console.error = originalConsole.error;
        }
        
        // Remove error handlers
        window.onerror = null;
        window.onunhandledrejection = null;
        
        // Disconnect observer
        observer.disconnect();
        
        isInitialized = false;
        originalConsole = null;
      };
      
      // Expose cleanup function
      window.__cleanupErrorMonitor = cleanup;
      
      return cleanup;
    }
    
    // Public API for manual error sending
    function sendErrorManually(error) {
      if (typeof window === 'undefined') {
        return false;
      }
      
      try {
        const message = error?.message || String(error);
        
        // Follow the same flow: check DOM first, then send console error if no DOM error
        return handleConsoleError("error", message, [error]);
      } catch (err) {
        console.log("Failed to manually send error:", err);
        return false;
      }
    }
    
    // Small delay to let app initialize first
    initialize();
    
    // Return the public API
    return {
      sendError: sendErrorManually,
      checkForErrors: checkDomErrors,
      cleanup: () => window.__cleanupErrorMonitor?.()
    };
  }

  // Auto-initialize when DOM is ready
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
      // DOM is already ready
      window.__errorMonitorAPI = initEnhancedErrorMonitor({
        debug: true,
        debounceTime: 0,
        domCheckDelay: 0
      });
    }
  }

  // Start initialization
  initWhenReady();

  // Expose the init function globally for manual initialization if needed
  window.__initErrorMonitor = initEnhancedErrorMonitor;

})();