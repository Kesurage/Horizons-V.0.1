// This file customizes webpack configuration for react-app-rewired.
const ModuleScopePlugin = require('react-dev-utils/ModuleScopePlugin');

module.exports = {
  webpack: function override(config, env) {
    config.module.rules.push({
      test: /\.worker\.js$/,
      use: {
        loader: 'worker-loader',
        options: {
          filename: '[name].[contenthash].worker.js',
        },
      },
    });

    // A lot of packages we use in node_modules trigger source map warnings
    // but it is not a blocking issue, so we ignore them.
    config.ignoreWarnings = [/Failed to parse source map/];

    config.resolve.plugins = config.resolve.plugins.filter(
      (plugin) => !(plugin instanceof ModuleScopePlugin)
    );

    // Low-memory build mode (e.g. CI containers with ~4GB RAM):
    // skip type checking, source maps and parallel minification so that
    // the production build fits in memory.
    if (process.env.LOW_MEMORY) {
      config.plugins = config.plugins.filter(
        (plugin) =>
          !plugin ||
          !plugin.constructor ||
          plugin.constructor.name !== 'ForkTsCheckerWebpackPlugin'
      );
      config.optimization = config.optimization || {};
      if (Array.isArray(config.optimization.minimizer)) {
        config.optimization.minimizer = config.optimization.minimizer.map(
          (plugin) => {
            if (
              plugin &&
              plugin.constructor &&
              (plugin.constructor.name === 'TerserPlugin' ||
                plugin.constructor.name === 'ESLintPlugin')
            ) {
              if (plugin.constructor.name === 'TerserPlugin') {
                plugin.options.parallel = false;
              }
            }
            return plugin;
          }
        );
      }
      config.devtool = false;
    }

    return config;
  },

  jest: function(config) {
    config.transformIgnorePatterns = [
      '<rootDir>/node_modules/(?!react-markdown|vfile|unist-.*|unified|bail|trough|character-entities|remark-parse|mdast-util-.*|micromark|decode-named-character-reference|remark-rehype|property-information|hast-util-.*|space-separated-tokens|comma-separated-tokens|ccount|escape-string-regexp|trim-lines|hast-util-whitespace|remark-gfm|mdast-util-gfm|mdast-util-find-and-replace|mdast-util-to-markdown|markdown-table|is-plain-obj)',
    ];

    return config;
  },
};
