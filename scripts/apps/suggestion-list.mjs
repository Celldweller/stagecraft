/**
 * A text input as a combobox with a suggestion list, shared by the tag editor and the dialog properties (tags).
 * Typing filters, a click on the input opens the list, arrow keys move, Enter takes the
 * highlighted suggestion (or hands the typed text to the window), Esc closes the list without closing the window.
 *
 * The list is a popover in the top layer, so the window never clips it; it sits below the input, or above it if
 * there is more room there (CSS: styles/stagecraft.css, "Suggestion list"). Options are built with DOM properties;
 * labels are text, never HTML.
 */
import { normalizeSearchText } from "../lib/search.mjs";

/**
 * @typedef {object} Suggestion
 * @property {string} value          What a pick hands over (a tag, a dialog id).
 * @property {string} label          Shown text.
 * @property {string} [search]       Text searched instead of the label.
 * @property {string} [alt]          Further text a match may start with (e.g. a tag without its prefix).
 * @property {number} [rank]         Higher first among equal matches; then by label.
 * @property {string} [note]         Small text at the end of the line (a count).
 * @property {string} [kind]         `data-kind` of the option (tag colours).
 */

/** Most suggestions listed at once; the list scrolls, typing narrows it. */
const MAX_SUGGESTIONS = 100;

export class SuggestionList {
  /**
   * @param {object} config
   * @param {HTMLInputElement} config.input
   * @param {HTMLElement} config.list         `<ul role="listbox" popover="manual">`
   * @param {() => Suggestion[]} config.items  The current candidates, asked on every update.
   * @param {(item: Suggestion) => void} config.onPick  A suggestion was chosen.
   * @param {(text: string) => void} [config.onEnter]   Enter without a highlighted suggestion.
   */
  constructor({input, list, items, onPick, onEnter}) {
    this.input = input;
    this.list = list;
    this.items = items;
    this.onPick = onPick;
    this.onEnter = onEnter;
    this.#bind();
  }

  /** @type {Suggestion[]} */
  #suggestions = [];

  /** Highlighted suggestion; -1 = none. */
  #active = -1;

  /** @returns {Suggestion[]}  The suggestions shown now. */
  get suggestions() {
    return this.#suggestions;
  }

  #bind() {
    const {input, list} = this;
    input.addEventListener("input", () => this.update());
    input.addEventListener("click", () => this.update());
    input.addEventListener("blur", () => this.close());
    input.addEventListener("keydown", event => this.#onKeydown(event));
    // Keep the focus in the input while an option is clicked.
    list.addEventListener("mousedown", event => event.preventDefault());
    list.addEventListener("click", event => {
      const option = event.target.closest("[role=option]");
      const item = option && this.#suggestions[Number(option.dataset.index)];
      if ( item ) this.#pick(item);
    });
  }

  /** @param {KeyboardEvent} event */
  #onKeydown(event) {
    const open = this.#suggestions.length > 0;
    switch ( event.key ) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if ( !open ) return this.update();
        const n = this.#suggestions.length;
        const step = (event.key === "ArrowDown") ? 1 : -1;
        this.#active = (this.#active < 0) ? (step > 0 ? 0 : n - 1) : (this.#active + step + n) % n;
        this.#render();
        return;
      }
      case "Enter":
        // Enter takes a suggestion or the typed text; saving the window needs its button.
        event.preventDefault();
        if ( open && (this.#active >= 0) ) return this.#pick(this.#suggestions[this.#active]);
        this.onEnter?.(this.input.value);
        return;
      case "Escape":
        if ( !open ) return;
        // Close only the list, not the window.
        event.preventDefault();
        event.stopPropagation();
        this.close();
    }
  }

  /** @param {Suggestion} item */
  #pick(item) {
    this.close();
    this.onPick(item);
  }

  /** Recompute the suggestions for the typed text: matches starting with it first, then by rank and label. */
  update() {
    const query = normalizeSearchText(this.input.value);
    const scored = [];
    for ( const item of this.items() ) {
      const text = normalizeSearchText(item.search ?? item.label);
      if ( query && !text.includes(query) ) continue;
      const starts = !query || normalizeSearchText(item.label).startsWith(query)
        || normalizeSearchText(item.alt ?? "").startsWith(query);
      scored.push({item, starts});
    }
    this.#suggestions = scored
      .sort((a, b) => (Number(b.starts) - Number(a.starts)) || ((b.item.rank ?? 0) - (a.item.rank ?? 0))
        || a.item.label.localeCompare(b.item.label, game.i18n.lang, {numeric: true, sensitivity: "base"}))
      .slice(0, MAX_SUGGESTIONS)
      .map(s => s.item);
    this.#active = -1;
    this.#render();
  }

  close() {
    this.#suggestions = [];
    this.#active = -1;
    this.#render();
  }

  /** Show the suggestions as listbox options. */
  #render() {
    const {input, list} = this;
    if ( !input.isConnected || !list.isConnected ) return;
    const options = this.#suggestions.map((item, i) => {
      const li = document.createElement("li");
      li.id = `${list.id}-${i}`;
      li.setAttribute("role", "option");
      li.dataset.index = String(i);
      if ( item.kind ) li.dataset.kind = item.kind;
      li.setAttribute("aria-selected", String(i === this.#active));
      const text = document.createElement("span");
      text.className = "stagecraft-suggestion-text";
      text.textContent = item.label;
      li.append(text);
      if ( item.note ) {
        const note = document.createElement("span");
        note.className = "stagecraft-suggestion-note";
        note.textContent = item.note;
        li.append(note);
      }
      return li;
    });
    list.replaceChildren(...options);
    const open = options.length > 0;
    input.setAttribute("aria-expanded", String(open));
    if ( open ) {
      if ( !list.matches(":popover-open") ) list.showPopover();
      this.#position();
    }
    else if ( list.matches(":popover-open") ) list.hidePopover();
    if ( this.#active >= 0 ) {
      input.setAttribute("aria-activedescendant", options[this.#active].id);
      options[this.#active].scrollIntoView({block: "nearest"});
    }
    else input.removeAttribute("aria-activedescendant");
  }

  /**
   * Place the list below the input, or above it if there is more room there. JS passes the raw geometry as custom
   * properties; gap and maximum height are applied in CSS.
   */
  #position() {
    const {input, list} = this;
    const rect = input.getBoundingClientRect();
    const wanted = list.scrollHeight; // Full content height, independent of the CSS maximum.
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    const placeBelow = (below >= wanted) || (below >= above);
    list.classList.toggle("above", !placeBelow);
    list.style.setProperty("--stagecraft-suggestions-room", `${Math.max(placeBelow ? below : above, 0)}px`);
    list.style.setProperty("--stagecraft-suggestions-left", `${rect.left}px`);
    list.style.setProperty("--stagecraft-suggestions-width", `${rect.width}px`);
    list.style.setProperty("--stagecraft-suggestions-top", `${rect.bottom}px`);
    list.style.setProperty("--stagecraft-suggestions-bottom", `${window.innerHeight - rect.top}px`);
  }
}
