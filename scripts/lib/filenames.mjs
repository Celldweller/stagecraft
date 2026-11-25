/**
 * Pure helpers that turn image paths into stages: a location plus an optional variant.
 *
 * No Foundry globals in here, so everything is testable with `node --test`.
 * Runtime callers pass Foundry-specific data (e.g. `CONST.IMAGE_FILE_EXTENSIONS`) in as arguments.
 */

/** Default template for recognising variants: `Harbor (Night Rain)`. */
export const DEFAULT_VARIANT_TEMPLATE = "{name} ({variant})";

/** Extension preference when one stage variant exists in several formats. Lower index wins. */
export const DEFAULT_EXTENSION_PREFERENCE = Object.freeze(["webp", "avif", "jpg", "jpeg", "png", "gif", "apng", "bmp", "tiff", "svg"]);

/** Longest name the variant pattern is applied to. Real file names are far shorter; this caps regex cost. */
const MAX_NAME_LENGTH = 512;

/**
 * A trailing size suffix such as `2800x1750`, separated by whitespace or at the very start.
 * A copy number after it (`2800x1575 2`) is kept as part of the name.
 */
const DIMENSIONS = /(?:^|\s)(\d{2,5})\s*[x×]\s*(\d{2,5})(?:\s+(\d{1,3}))?$/i;

/** Separator between name parts: a hyphen with whitespace on at least one side ("A - B", "A -B", "A- B"). */
export const NAME_PART_SEPARATOR = /\s+-\s*|\s*-\s+/;

const PLACEHOLDER_NAME = "{name}";
const PLACEHOLDER_VARIANT = "{variant}";

/**
 * @typedef {object} VariantPatternConfig
 * @property {"template"|"regex"} [mode="template"]  Simplified template or a raw regular expression.
 * @property {string} [template]  For mode "template": must contain `{name}` and `{variant}` exactly once.
 * @property {string} [regex]     For mode "regex": must define the named groups `name` and `variant`.
 */

/**
 * @typedef {object} CompiledPattern
 * @property {true} ok
 * @property {RegExp} regex
 */

/**
 * @typedef {object} PatternError
 * @property {false} ok
 * @property {string} error  A stable error code, suitable as a localization key suffix.
 */

/**
 * Read the single-string variant setting: `/…/` is a raw regular expression, anything else a template.
 * @param {string} value
 * @returns {VariantPatternConfig}
 */
export function parseVariantSetting(value) {
  const text = String(value ?? "").trim();
  if ( text.length >= 2 && text.startsWith("/") && text.endsWith("/") ) return {mode: "regex", regex: text.slice(1, -1)};
  return {mode: "template", template: text || DEFAULT_VARIANT_TEMPLATE};
}

/**
 * Compile a user-supplied variant pattern. Never throws: invalid input yields `{ok: false}`.
 * @param {VariantPatternConfig} [config]
 * @returns {CompiledPattern|PatternError}
 */
export function compileVariantPattern(config = {}) {
  const mode = config.mode ?? "template";
  if ( mode === "template" ) return compileTemplate(config.template ?? DEFAULT_VARIANT_TEMPLATE);
  if ( mode === "regex" ) return compileRegex(config.regex);
  return {ok: false, error: "UnknownMode"};
}

/**
 * Turn a template like `{name} ({variant})` into an anchored regular expression.
 * Everything except the two placeholders is matched literally; runs of spaces match any whitespace.
 * The name is matched greedily, so with repeated separators the variant is the last part:
 * `A (x) (y)` gives name `A (x)` and variant `y`.
 * @param {string} template
 * @returns {CompiledPattern|PatternError}
 */
function compileTemplate(template) {
  if ( typeof template !== "string" ) return {ok: false, error: "NotAString"};
  if ( template.length > 200 ) return {ok: false, error: "TooLong"};
  if ( countOccurrences(template, PLACEHOLDER_NAME) !== 1 ) return {ok: false, error: "NeedsOneName"};
  if ( countOccurrences(template, PLACEHOLDER_VARIANT) !== 1 ) return {ok: false, error: "NeedsOneVariant"};
  const source = template
    .split(/(\{name\}|\{variant\})/)
    .map(part => {
      if ( part === PLACEHOLDER_NAME ) return "(?<name>.+)";
      if ( part === PLACEHOLDER_VARIANT ) return "(?<variant>.+?)";
      return escapeRegex(part).replace(/ +/g, "\\s*");
    })
    .join("");
  return {ok: true, regex: new RegExp(`^${source}$`, "u")};
}

/**
 * Validate and compile a raw regular expression with the named groups `name` and `variant`.
 * @param {string} source
 * @returns {CompiledPattern|PatternError}
 */
function compileRegex(source) {
  if ( typeof source !== "string" || !source.length ) return {ok: false, error: "NotAString"};
  if ( source.length > 500 ) return {ok: false, error: "TooLong"};
  let regex;
  try {
    regex = new RegExp(source, "u");
  } catch {
    return {ok: false, error: "InvalidRegex"};
  }
  // An empty alternative makes the expression match "", which reveals all declared group names.
  const groups = new RegExp(`(?:${source})|`, "u").exec("")?.groups ?? {};
  if ( !("name" in groups) ) return {ok: false, error: "NeedsNameGroup"};
  if ( !("variant" in groups) ) return {ok: false, error: "NeedsVariantGroup"};
  return {ok: true, regex};
}

/**
 * @typedef {object} StageEntry
 * @property {string} path         The original path, unchanged, as Foundry delivered it.
 * @property {string} folder       Decoded folder part of the path, without trailing slash ("" for none).
 * @property {string} file         Decoded file name including extension.
 * @property {string} ext          Lower-case extension without dot ("" for none).
 * @property {string} name         Location name: whitespace-normalised, without size suffix and variant.
 * @property {string|null} variant Variant label, or null for the base variant.
 * @property {{width: number, height: number}|null} dimensions  Size suffix from the name, if present.
 * @property {string} locationKey  Case-insensitive grouping key derived from `name`.
 */

/**
 * Parse one image path into a stage entry.
 * @param {string} path
 * @param {{pattern?: RegExp|null}} [options]  A pattern from `compileVariantPattern`; defaults to the template
 *   default. `null` disables variant detection (cards).
 * @returns {StageEntry}
 */
export function parseStagePath(path, {pattern=DEFAULT_PATTERN} = {}) {
  const decoded = safeDecode(String(path));
  const slash = decoded.lastIndexOf("/");
  const folder = slash >= 0 ? decoded.slice(0, slash) : "";
  const file = slash >= 0 ? decoded.slice(slash + 1) : decoded;
  const dot = file.lastIndexOf(".");
  const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
  let name = normalizeWhitespace(dot > 0 ? file.slice(0, dot) : file);

  let dimensions = null;
  ({name, dimensions} = stripDimensions(name, dimensions));

  let variant = null;
  const match = (pattern && (name.length <= MAX_NAME_LENGTH)) ? pattern.exec(name) : null;
  const matchedName = match?.groups?.name?.trim();
  const matchedVariant = match?.groups?.variant?.trim();
  if ( matchedName && matchedVariant ) {
    name = matchedName;
    variant = normalizeWhitespace(matchedVariant);
  }

  // A size suffix may also sit before the variant: "Hall 2800x1569 (Darkvision)".
  ({name, dimensions} = stripDimensions(name, dimensions));

  return {path: String(path), folder, file, ext, name, variant, dimensions, locationKey: toKey(name)};
}

/** The compiled default pattern, built once. */
const DEFAULT_PATTERN = compileTemplate(DEFAULT_VARIANT_TEMPLATE).regex;

/**
 * Whether a path points to an image, judged by its extension.
 * @param {string} path
 * @param {Iterable<string>} extensions  Allowed extensions without dot, e.g. `Object.keys(CONST.IMAGE_FILE_EXTENSIONS)`.
 * @returns {boolean}
 */
export function isImagePath(path, extensions) {
  const allowed = new Set([...extensions].map(e => String(e).toLowerCase()));
  const clean = String(path).split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  if ( dot < 0 || dot < clean.lastIndexOf("/") ) return false;
  return allowed.has(clean.slice(dot + 1).toLowerCase());
}

/**
 * @typedef {object} StageVariant
 * @property {string|null} variant   Variant label, null for the base variant.
 * @property {StageEntry} preferred  The file to show, chosen by extension preference.
 * @property {StageEntry[]} files    All files of this variant (several formats possible).
 */

/**
 * @typedef {object} StageLocation
 * @property {string} key             The grouping key.
 * @property {string} name            Display name, taken from the first entry seen.
 * @property {StageVariant[]} variants  Base variant first, then the others alphabetically.
 */

/**
 * Group parsed entries by location and variant.
 * @param {StageEntry[]} entries
 * @param {{extensionPreference?: string[]}} [options]
 * @returns {StageLocation[]}  Sorted by name, numbers in natural order.
 */
export function groupByLocation(entries, {extensionPreference=DEFAULT_EXTENSION_PREFERENCE} = {}) {
  /** @type {Map<string, {key: string, name: string, variants: Map<string, StageEntry[]>}>} */
  const locations = new Map();
  for ( const entry of entries ) {
    let location = locations.get(entry.locationKey);
    if ( !location ) {
      location = {key: entry.locationKey, name: entry.name, variants: new Map()};
      locations.set(entry.locationKey, location);
    }
    const variantKey = entry.variant === null ? "" : toKey(entry.variant);
    const files = location.variants.get(variantKey) ?? [];
    files.push(entry);
    location.variants.set(variantKey, files);
  }

  const rank = ext => {
    const index = extensionPreference.indexOf(ext);
    return index < 0 ? extensionPreference.length : index;
  };

  return [...locations.values()]
    .map(location => ({
      key: location.key,
      name: location.name,
      variants: [...location.variants.entries()]
        .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : compareNatural(a, b)))
        .map(([, files]) => {
          const sorted = [...files].sort((a, b) => (rank(a.ext) - rank(b.ext)) || compareNatural(a.path, b.path));
          return {variant: sorted[0].variant, preferred: sorted[0], files: sorted};
        })
    }))
    .sort((a, b) => compareNatural(a.name, b.name));
}

/**
 * Compare strings case-insensitively with numbers in natural order ("Swamp 4" before "Swamp 10").
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareNatural(a, b) {
  return a.localeCompare(b, "en", {numeric: true, sensitivity: "base"});
}

/**
 * Collapse runs of whitespace to single spaces and trim.
 * @param {string} text
 * @returns {string}
 */
export function normalizeWhitespace(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

/**
 * @param {string} name
 * @param {{width: number, height: number}|null} dimensions
 * @returns {{name: string, dimensions: {width: number, height: number}|null}}
 */
function stripDimensions(name, dimensions) {
  const match = DIMENSIONS.exec(name);
  if ( !match ) return {name, dimensions};
  const stripped = name.slice(0, match.index).trim();
  if ( !stripped ) return {name, dimensions}; // Never reduce a name to nothing.
  const copyNumber = match[3] ? ` ${match[3]}` : "";
  return {name: stripped + copyNumber, dimensions: dimensions ?? {width: Number(match[1]), height: Number(match[2])}};
}

/**
 * @param {string} text
 * @returns {string}
 */
export function toKey(text) {
  return normalizeWhitespace(text).toLocaleLowerCase("en");
}

/**
 * Decode percent-encoding if present; return the input unchanged if it is not valid encoding.
 * @param {string} text
 * @returns {string}
 */
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} text
 * @param {string} search
 * @returns {number}
 */
function countOccurrences(text, search) {
  return text.split(search).length - 1;
}
