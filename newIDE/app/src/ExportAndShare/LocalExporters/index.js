// @flow
import { type Exporter } from '../ShareDialog';
import { localCordovaExportPipeline } from './LocalCordovaExport';
import { localElectronExportPipeline } from './LocalElectronExport';
import { localHTML5ExportPipeline } from './LocalHTML5Export';
import { localOnlineWebExportPipeline } from './LocalOnlineWebExport';
import { cordovaExporter } from '../GenericExporters/CordovaExport';
import { onlineWebExporter } from '../GenericExporters/OnlineWebExport';
import { html5Exporter } from '../GenericExporters/HTML5Export';
import { electronExporter } from '../GenericExporters/ElectronExport';

// Horizons: GDevelop's online build service (Android/iOS/Windows/Linux
// cloud builds) and Facebook Instant Games export were removed. What stays:
//  - local HTML5 export (works offline)
//  - "manual" Cordova/Electron exports: they produce a project package you
//    can build into an APK/desktop app yourself, without any GDevelop service.

// $FlowFixMe[incompatible-type]
export const localOnlineWebExporter: Exporter = {
  ...onlineWebExporter,
  exportPipeline: localOnlineWebExportPipeline,
};

export const localAutomatedExporters: Array<Exporter> = [
  // $FlowFixMe[incompatible-type]
  {
    ...html5Exporter,
    exportPipeline: localHTML5ExportPipeline,
  },
];

export const localManualExporters: Array<Exporter> = [
  // $FlowFixMe[incompatible-type]
  {
    ...html5Exporter,
    exportPipeline: localHTML5ExportPipeline,
  },
  // $FlowFixMe[incompatible-type]
  {
    ...cordovaExporter,
    exportPipeline: localCordovaExportPipeline,
  },
  // $FlowFixMe[incompatible-type]
  {
    ...electronExporter,
    exportPipeline: localElectronExportPipeline,
  },
];
