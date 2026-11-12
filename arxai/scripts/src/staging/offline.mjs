// Preloaded in every staging child, including descendants. No public sockets.
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
export function isLocalHost(host) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let options = args[0];
  // node's internal normalized argument form.
  if (Array.isArray(options)) options = options[0];
  const host = options && typeof options === 'object' ? options.host : typeof args[1] === 'string' ? args[1] : 'localhost';
  const unix = options && typeof options === 'object' ? options.path : typeof options === 'string' && !/^\d+$/.test(options) ? options : null;
  if (!unix && !isLocalHost(host ?? 'localhost')) throw new Error('Staging sandbox blocked a non-loopback socket');
  return originalConnect.apply(this, args);
};
syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['http:', 'https:'].includes(url.protocol) || !isLocalHost(url.hostname)) return Promise.reject(new Error('Staging sandbox blocked a non-loopback fetch'));
  return originalFetch(input, init);
};
