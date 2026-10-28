// @flow
import { type Exporter } from '../ShareDialog';
import { browserOnlineWebExportPipeline } from './BrowserOnlineWebExport';
import { browserHTML5ExportPipeline } from './BrowserHTML5Export';
import { browserCordovaExportPipeline } from './BrowserCordovaExport';
import { browserElectronExportPipeline } from './BrowserElectronExport';
import { onlineWebExporter } from '../GenericExporters/OnlineWebExport';
import { html5Exporter } from '../GenericExporters/HTML5Export';
import { cordovaExporter } from '../GenericExporters/CordovaExport';
import { electronExporter } from '../GenericExporters/ElectronExport';

// Horizons: GDevelop's online build service (Android/iOS/Windows/Linux
// cloud builds) and Facebook Instant Games export were removed. What stays:
//  - local HTML5 export (works offline)
//  - "manual" Cordova/Electron exports: they produce a project package you
//    can build into an APK/desktop app yourself, without any GDevelop service.

// $FlowFixMe[incompatible-type]
export const browserOnlineWebExporter: Exporter = {
  ...onlineWebExporter,
  exportPipeline: browserOnlineWebExportPipeline,
};

export const browserAutomatedExporters: Array<Exporter> = [
  // $FlowFixMe[incompatible-type]
  {
    ...html5Exporter,
    exportPipeline: browserHTML5ExportPipeline,
  },
];

export const browserManualExporters: Array<Exporter> = [
  // $FlowFixMe[incompatible-type]
  {
    ...html5Exporter,
    exportPipeline: browserHTML5ExportPipeline,
  },
  // $FlowFixMe[incompatible-type]
  {
    ...cordovaExporter,
    exportPipeline: browserCordovaExportPipeline,
  },
  // $FlowFixMe[incompatible-type]
  {
    ...electronExporter,
    exportPipeline: browserElectronExportPipeline,
  },
];
