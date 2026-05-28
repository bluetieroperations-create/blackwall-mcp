/**
 * Barrel for the BLACK_WALL client library.
 *
 *   import { forecast, observe } from 'blackwall-mcp/lib';
 *
 * Individual entry points are also exported in package.json:
 *   import { forecast } from 'blackwall-mcp/lib/forecast';
 *   import { observe } from 'blackwall-mcp/lib/observe';
 */
export { forecast } from './forecast.mjs';
export { observe } from './observe.mjs';
