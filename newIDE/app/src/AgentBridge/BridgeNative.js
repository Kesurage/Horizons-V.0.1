// @flow
/**
 * Access to the native "BridgeServer" Capacitor plugin.
 *
 * In the Android app, Capacitor injects `window.Capacitor` with a
 * `Plugins` proxy exposing every registered plugin. The plugin is
 * registered by MainActivity (see android-app/bridge-src).
 *
 * In a desktop browser (development), the plugin is absent — everything
 * built on top of this module must degrade gracefully.
 */

export type NativeBridgePlugin = {
  start: (options: { port?: number }) => Promise<any>,
  stop: () => Promise<any>,
  respond: (payload: {
    id: string,
    status: number,
    body: string,
  }) => Promise<any>,
  getState: () => Promise<any>,
  startTunnel: (options: { server?: string, subdomain?: string }) => Promise<any>,
  stopTunnel: () => Promise<any>,
  addListener: (
    eventName: string,
    callback: (data: any) => void
  ) => { remove: () => void },
};

export const getBridgePlugin = (): any => {
  if (typeof window === 'undefined') return null;
  const capacitor = window.Capacitor;
  if (!capacitor || !capacitor.Plugins) return null;
  const plugin = capacitor.Plugins.BridgeServer;
  return plugin || null;
};

export const isBridgeAvailable = (): boolean => !!getBridgePlugin();
