const fs = require('fs');
const path = require('path');
const shell = require('shelljs');
const workboxBuild = require('workbox-build');
const VersionMetadata = require('../src/Version/VersionMetadata');

/**
 * When SW_BUILD_DIR is set (e.g. `SW_BUILD_DIR=../build node make-service-worker.js`
 * run from scripts/ AFTER `react-app-rewired build`), the service worker is
 * generated against the real build output, so the precache manifest also
 * includes the hashed static assets. Otherwise, keep the legacy behavior
 * (pre-build generation in public/).
 */
const buildPath = process.env.SW_BUILD_DIR || '../public';
const swDestPath = process.env.SW_BUILD_DIR
  ? path.join(buildPath, 'service-worker.js')
  : '../public/service-worker.js';
const additionalGlobPatterns = process.env.SW_BUILD_DIR
  ? [
      'static/js/*.js', // Hashed app bundles.
      'static/css/*.css',
      'static/media/*',
    ]
  : [];

/**
 * Remove files created by create-react-app default service worker.
 */
const cleanBuildFiles = () => {
  const listBuildFiles = () =>
    new Promise((resolve, reject) => {
      fs.readdir(buildPath, (err, files) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(files);
      });
    });

  return listBuildFiles().then(files => {
    files
      .filter(filename => filename.indexOf('precache-manifest.') === 0)
      .forEach(filename => {
        fs.unlinkSync(path.join(buildPath, filename));
      });
  });
};

const replaceInFile = (file, searchText, replacedText) => {
  if (shell.sed('-i', searchText, replacedText, file).code !== 0) {
    return false;
  }

  // Ensure the replaced text can be found in the file:
  return !!shell.grep(replacedText, file).stdout.trim();
};

/**
 * Create the service worker with workbox.
 */
const buildSW = () => {
  return workboxBuild
    .injectManifest({
      swSrc: 'service-worker-template/service-worker-template.js',
      swDest: swDestPath,
      globDirectory: buildPath,
      globPatterns: [
        // Application:
        '!(libGD)*.{js,css,html,png}', // Root files.
        'static/css/*.css',
        'static/media/*',
        'static/js/locales-*.js', // Locales.
        'static/js/!local-app*.js', // Exclude electron app.
        'static/js/Resource3DPreview.worker.*.js', // Include the 3D preview worker
        'static/js/BackgroundSerializer.worker.*.js', // Include the serializer worker
        ...additionalGlobPatterns,
        // ...But not libGD.js/wasm (there are cached with their URL
        // query string that depends on the VersionMetadata, see below).

        // Resources:
        '{JsPlatform,CppPlatform,res}/**/*.png',

        // External libs:

        // Zip.js
        'external/zip.js/WebContent/{deflate,inflate,z-worker,zip}.js', // Zip.js
        'external/zip.js/WebContent/zlib-asm/codecs.js', // zlib-asm codec for Zip.js
        'external/zlib-asm/zlib.js', // zlib-asm

        // Monaco Editor (for JavaScript)
        'external/monaco-editor-min/vs/loader.js',
        'external/monaco-editor-min/vs/base/worker/workerMain.js',
        'external/monaco-editor-min/vs/basic-languages/javascript/javascript.js',
        'external/monaco-editor-min/vs/language/typescript/tsMode.js',
        'external/monaco-editor-min/vs/language/typescript/tsWorker.js',
        // 'external/monaco-editor-min/vs/editor/editor.main.js', // Seems useless?
        // 'external/monaco-editor-min/vs/editor/editor.main.css',
      ],

      // Increase the limit to 10mb:
      maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
    })
    .then(({ count, size, warnings }) => {
      if (
        !replaceInFile(
          swDestPath,
          'VersionMetadata = {}',
          'VersionMetadata = ' + JSON.stringify(VersionMetadata)
        )
      ) {
        console.error(
          'Error while trying to replace version metadata in public/service-worker.js.'
        );
        shell.exit(1);
      }

      // Optionally, log any warnings and details.
      warnings.forEach(warning => {
        console.log(`⚠️ workbox warning: ${warning}`);
      });
      console.log(
        `ℹ️ ${count} files will be precached, totaling ${size /
          1000 /
          1000} MB.`
      );
    });
};

cleanBuildFiles().then(() => buildSW());
