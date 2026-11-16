// Keep a service-worker target available for chrome.tabs.setZoom from the test.
// No network access, content scripts or application privileges.
chrome.runtime.onInstalled.addListener(() => {});
