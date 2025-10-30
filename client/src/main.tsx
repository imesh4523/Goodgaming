import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import DisableDevtool from 'disable-devtool';

const removeReplitAttributes = () => {
  const elements = document.querySelectorAll('[data-replit-metadata], [data-component-name]');
  elements.forEach(el => {
    el.removeAttribute('data-replit-metadata');
    el.removeAttribute('data-component-name');
  });
};

const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    if (mutation.type === 'attributes') {
      const target = mutation.target as Element;
      target.removeAttribute('data-replit-metadata');
      target.removeAttribute('data-component-name');
    } else if (mutation.addedNodes.length > 0) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) {
          const element = node as Element;
          element.removeAttribute('data-replit-metadata');
          element.removeAttribute('data-component-name');
          const children = element.querySelectorAll('[data-replit-metadata], [data-component-name]');
          children.forEach(child => {
            child.removeAttribute('data-replit-metadata');
            child.removeAttribute('data-component-name');
          });
        }
      });
    }
  });
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['data-replit-metadata', 'data-component-name']
});

removeReplitAttributes();

if (import.meta.env.PROD) {
  DisableDevtool({
    disableMenu: true,
    disableSelect: true,
    disableCopy: true,
    disableCut: true,
    disablePaste: true,
    clearLog: true,
    detectors: [0, 1, 2, 3, 4, 5, 6, 7],
    ondevtoolopen: (type: number, next: () => void) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.95);z-index:999999;display:flex;align-items:center;justify-content:center;color:white;font-family:sans-serif;';
      overlay.innerHTML = '<div style="text-align:center;padding:2rem;"><h2 style="margin-bottom:1rem;">Developer Tools Detected</h2><p>For security reasons, developer tools are restricted on this platform.</p></div>';
      document.body.appendChild(overlay);
    },
  });
}

if ('serviceWorker' in navigator && import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then(registration => {
        console.log('PWA: Service Worker registered successfully:', registration);
      })
      .catch(error => {
        console.log('PWA: Service Worker registration failed:', error);
      });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
