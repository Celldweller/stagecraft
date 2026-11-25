/**
 * Context menu entries for Foundry v13 (branch v13). The module writes its entries in the v14 form
 * `{label, icon, visible, onClick(event, target)}` with `icon` as Font Awesome classes; v13's ContextMenu expects
 * `{name, icon, condition, callback(target)}` with `icon` as HTML. MediaBrowser#_createContextMenu converts them.
 */

/**
 * @typedef ModuleContextEntry
 * @property {string} label                       Localization key.
 * @property {string} [icon]                      Font Awesome classes, e.g. "fa-solid fa-tags".
 * @property {string} [group]
 * @property {string} [classes]
 * @property {((target: HTMLElement) => boolean)|boolean} [visible]
 * @property {(event: Event|null, target: HTMLElement) => unknown} onClick
 */

/**
 * Convert entries to the form v13 expects. Entries already in that form (with `name`) stay as they are.
 * v13 hands the callback only the target, so `onClick` gets `null` as event.
 * @param {ModuleContextEntry[]} entries
 * @returns {object[]}
 */
export function toV13ContextEntries(entries) {
  return entries.map(entry => {
    if ( !entry || ("name" in entry) ) return entry;
    const {label, icon, visible, onClick, ...rest} = entry;
    const converted = {...rest, name: label, callback: target => onClick?.(null, target)};
    if ( icon ) converted.icon = `<i class="${icon}"></i>`;
    if ( visible !== undefined ) converted.condition = visible;
    return converted;
  });
}
