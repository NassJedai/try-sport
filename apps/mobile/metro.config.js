const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

/**
 * Metro must be told about the monorepo explicitly: workspace packages live
 * outside the app directory, and their sources are consumed as TypeScript rather
 * than as built output, so Metro is what compiles them.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Two copies of React would break hooks; resolve from the app outward only.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
