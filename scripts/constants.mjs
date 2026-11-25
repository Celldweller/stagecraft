/**
 * Shared constants for Stagecraft. Kept free of Foundry globals so that
 * modules importing it stay testable with `node --test`.
 */

/** The module ID, identical to the folder name and the `id` in module.json. */
export const MODULE_ID = "stagecraft";

/** The socket event name Foundry registers for this module (`"socket": true`). */
export const SOCKET_NAME = `module.${MODULE_ID}`;
